// Leak rules: what an effect (or componentDidMount) starts and its cleanup never stops. Only what is visible in
// the file is judged; anything handed to a helper we cannot see counts as handled (precision over recall).
import {
  calleeName,
  isCall,
  isFunction,
  isMember,
  isStateSetter,
  lineOf,
  normalized,
  sourceOf,
  stringValue,
  unwrap
} from './ast.mjs';

const EFFECT_HOOKS = new Set(['useEffect', 'useLayoutEffect', 'useInsertionEffect']);
const FOCUS_HOOKS = new Set(['useFocusEffect']);
const OBSERVERS = new Set(['IntersectionObserver', 'ResizeObserver', 'MutationObserver', 'PerformanceObserver']);
const CONNECTIONS = new Set(['WebSocket', 'EventSource', 'BroadcastChannel', 'Worker', 'SharedWorker']);
const RN_APIS = new Set(['Keyboard', 'AppState', 'Dimensions', 'BackHandler', 'Linking', 'DeviceEventEmitter', 'NetInfo', 'AccessibilityInfo']);
const SUBSCRIBE_METHODS = new Set(['subscribe', 'on', 'addListener', 'listen']);
const REMOVER_NAME = /remove|unbind|detach|cleanup|clean|unsubscribe|unlisten|teardown|destroy|dispose|off|stop|clear|cancel|abort|close/i;
// Removal APIs we understand (and match against what was added); any other remover-like call is a black box.
const STANDARD_REMOVERS = new Set([
  'remove', 'removeEventListener', 'removeListener', 'removeAllListeners', 'off', 'unsubscribe', 'unlisten', 'disconnect', 'unobserve',
  'close', 'terminate', 'abort', 'clearInterval', 'clearTimeout', 'cancelAnimationFrame', 'cancelIdleCallback'
]);
const HIGH_TARGETS = /^(window|document|document\.body|document\.documentElement|(window\.)?visualViewport|(window\.)?matchMedia\(.*\)|.*\.current)$/;

// Wrappers such as useMount/useUpdate run their callback in an effect. Whether they pass its return value on as
// the cleanup is not visible here, so a returned cleanup is assumed to run (no false positives either way).
const EFFECT_WRAPPERS = /^use(Mount|DidMount|EffectOnce|Update|UpdateEffect|UpdateOnly|DidUpdate|IsomorphicLayoutEffect|DeepCompareEffect|CustomCompareEffect)$/;
export const isEffectCall = name => EFFECT_HOOKS.has(name) || FOCUS_HOOKS.has(name) || EFFECT_WRAPPERS.test(name) || isUnmountHook(name);
export const isUnmountHook = name => /^use(Unmount|WillUnmount)$/.test(name);
export const isEffectWrapper = name => EFFECT_WRAPPERS.test(name);

// Whether an effect callback hands back a cleanup: a function, or what a subscribe-like call returned
// (`() => setX(y)` returns a value, not a cleanup).
export function returnsCleanup(fnPath) {
  const { fns, returnedNodes } = cleanupOf(fnPath);
  const subscription = node => isCall(node) && /^(subscribe|listen|addListener|addEventListener|on)$/.test(calleeName(node.callee) ?? '');
  return fns.length > 0 || [...returnedNodes].some(subscription);
}

// How a custom effect hook defined in the project treats its callback: 'discards' when it only calls it inside
// useEffect (`useEffect(() => { callback() }, deps)`), so a returned cleanup never runs; 'passes' otherwise.
export function wrapperSemantics(fnPath) {
  const param = fnPath.node.params[0];
  if (param?.type !== 'Identifier') return null;
  let verdict = null;
  fnPath.traverse({
    CallExpression(path) {
      if (!EFFECT_HOOKS.has(calleeName(path.node.callee) ?? '')) return;
      const effect = unwrap(path.node.arguments[0]);
      if (effect?.type === 'Identifier' && effect.name === param.name) return void (verdict = 'passes');
      if (!isFunction(effect)) return;
      if (effect.body.type !== 'BlockStatement') {
        const body = unwrap(effect.body);
        verdict = isCall(body) && body.callee.type === 'Identifier' && body.callee.name === param.name ? 'passes' : verdict;
        return;
      }
      const statements = effect.body.body;
      const calls = statements.some(
        statement =>
          statement.type === 'ExpressionStatement' &&
          isCall(unwrap(statement.expression)) &&
          unwrap(statement.expression).callee.type === 'Identifier' &&
          unwrap(statement.expression).callee.name === param.name
      );
      const returns = statements.some(statement => statement.type === 'ReturnStatement' && statement.argument);
      if (calls && !returns) verdict ??= 'discards';
      else if (returns) verdict = 'passes';
    }
  });
  return verdict;
}

// ---------- cleanup discovery ----------

// The functions an effect returns (directly, through a variable, from early returns) plus the local functions
// they call, and the values it returns as cleanup (`return unsubscribe`, `return store.subscribe(fn)`).
function cleanupOf(fnPath) {
  const fns = [];
  const returnedNodes = new Set();
  const returnedNames = new Set();
  const add = argPath => {
    const node = unwrap(argPath?.node);
    if (!node) return;
    if (isFunction(node)) fns.push(argPath);
    else if (node.type === 'Identifier') {
      returnedNames.add(node.name);
      const binding = argPath.scope.getBinding(node.name);
      if (binding?.path.isFunctionDeclaration()) fns.push(binding.path);
      else if (binding?.path.isVariableDeclarator()) {
        const init = binding.path.get('init');
        if (isFunction(unwrap(init.node))) fns.push(init);
        else if (isUseCallback(init.node)) fns.push(init.get('arguments.0'));
        else if (init.node) returnedNodes.add(unwrap(init.node));
      }
    } else if (isCall(node) || node.type === 'NewExpression') returnedNodes.add(node);
    else if (node.type === 'ConditionalExpression') {
      add(argPath.get('consequent'));
      add(argPath.get('alternate'));
    } else if (node.type === 'LogicalExpression') add(argPath.get('right'));
  };
  if (fnPath.node.body.type !== 'BlockStatement') add(fnPath.get('body'));
  else {
    fnPath.get('body').traverse({
      ReturnStatement(path) {
        if (path.getFunctionParent()?.node === fnPath.node) add(path.get('argument'));
      }
    });
  }
  return { fns, returnedNodes, returnedNames };
}

// Everything the cleanup code does, after following calls to local functions (and `this.method()` in classes).
function summarizeCleanup(fnPaths, text, classBody = null) {
  const seen = new Set();
  const calls = [];
  const sources = [];
  let assigns = 0;
  let opaqueRemover = false;
  const queue = [...fnPaths];
  const visit = path => {
    if (!path?.node || seen.has(path.node)) return;
    seen.add(path.node);
    sources.push(sourceOf(path.node, text));
    path.traverse({
      AssignmentExpression() {
        assigns += 1;
      },
      'CallExpression|OptionalCallExpression'(call) {
        const callee = unwrap(call.node.callee);
        const name = calleeName(callee);
        calls.push({
          name,
          object: isMember(callee) ? normalized(callee.object, text) : null,
          alias: isMember(callee) ? targetText(callee.object, call, text) : null,
          node: call.node,
          path: call
        });
        if (callee.type === 'Identifier') {
          const binding = call.scope.getBinding(callee.name);
          if (binding?.path.isFunctionDeclaration()) queue.push(binding.path);
          else if (binding?.path.isVariableDeclarator() && isFunction(unwrap(binding.path.node.init))) queue.push(binding.path.get('init'));
          else if (binding?.path.isVariableDeclarator() && isUseCallback(binding.path.node.init)) queue.push(binding.path.get('init.arguments.0'));
          else if (!binding?.path.isVariableDeclarator() && !STANDARD_REMOVERS.has(callee.name) && REMOVER_NAME.test(callee.name)) {
            opaqueRemover = true; // an imported/prop helper such as `unsubscribeAll()`: we cannot see what it removes
          }
        } else if (isMember(callee) && callee.object.type === 'ThisExpression' && classBody && name) {
          const method = classBody.get('body').find(item => (item.isClassMethod() || item.isClassProperty()) && item.node.key?.name === name);
          if (method) queue.push(method.isClassProperty() ? method.get('value') : method);
          else if (REMOVER_NAME.test(name)) opaqueRemover = true;
        } else if (isMember(callee) && name && !STANDARD_REMOVERS.has(name) && REMOVER_NAME.test(name)) {
          opaqueRemover = true; // e.g. `manager.dispose()`, `player.destroy()`
        }
      }
    });
  };
  while (queue.length) visit(queue.shift());
  return { calls, text: sources.join('\n'), assigns, opaqueRemover };
}

const isUseCallback = node => isCall(unwrap(node)) && calleeName(unwrap(node).callee) === 'useCallback' && isFunction(unwrap(unwrap(node).arguments[0]));

const mentions = (text, holder) => {
  if (!holder) return false;
  const escaped = holder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\./g, '\\??\\.');
  return new RegExp(`(^|[^\\w$.])${escaped}(?![\\w$])`).test(text.replace(/\s+/g, ''));
};

// Where the result of a call is kept: a variable/ref name, 'returned', null (dropped) or 'unknown' (passed on).
function holderOf(path, text) {
  let current = path;
  while (current.parentPath && /^(AwaitExpression|TSAsExpression|TSNonNullExpression|ParenthesizedExpression)$/.test(current.parentPath.node.type)) {
    current = current.parentPath;
  }
  const parent = current.parentPath;
  if (!parent) return null;
  if (parent.isExpressionStatement()) return null;
  if (parent.isVariableDeclarator() && current.key === 'init') {
    const id = parent.node.id;
    if (id.type === 'Identifier') return id.name;
    return 'unknown';
  }
  if (parent.isAssignmentExpression() && current.key === 'right') return normalized(parent.node.left, text);
  if (parent.isReturnStatement() || (parent.isArrowFunctionExpression() && current.key === 'body')) return 'returned';
  if ((parent.isCallExpression() || parent.isOptionalCallExpression()) && current.listKey === 'arguments') {
    const callee = unwrap(parent.node.callee);
    if (isMember(callee) && /^(push|add|set)$/.test(calleeName(callee) ?? '')) return normalized(callee.object, text);
  }
  return 'unknown';
}

const isRefHolder = holder => /\.current$|^this\./.test(holder ?? '');

// Whether `a.b.c` starts at an object the effect itself created (`new Image()`, `createElement`, a socket from
// `io()` when `calls` is set) or a callback parameter inside it: its lifetime ends with the effect's closure.
function createdInside(objectNode, path, fnPath, calls) {
  let node = unwrap(objectNode);
  while (isMember(node)) node = unwrap(node.object);
  if (!node) return false;
  if (node.type === 'NewExpression') return true;
  if (node.type !== 'Identifier') return false;
  const binding = path.scope.getBinding(node.name);
  if (!binding || !binding.path.findParent(item => item.node === fnPath.node)) return false;
  if (binding.kind === 'param') return true;
  const init = binding.path.isVariableDeclarator() ? unwrap(binding.path.node.init) : null;
  if (!init) return false;
  if (init.type === 'NewExpression') return true;
  return isCall(init) && (/^(createElement|createElementNS|cloneNode)$/.test(calleeName(init.callee) ?? '') || (calls && !isMember(unwrap(init.callee)?.object ?? null)));
}

// `const el = ref.current` / `const { current: el } = ref` → 'ref.current', so add and remove on an alias match.
function targetText(node, path, text) {
  node = unwrap(node);
  if (node?.type === 'Identifier') {
    const binding = path.scope.getBinding(node.name);
    const declarator = binding?.path.isVariableDeclarator() ? binding.path.node : null;
    const init = unwrap(declarator?.init);
    if (init && declarator.id.type === 'Identifier' && (isMember(init) || init.type === 'Identifier')) return normalized(init, text);
    if (init && declarator.id.type === 'ObjectPattern') {
      const property = declarator.id.properties.find(item => item.value?.type === 'Identifier' && item.value.name === node.name);
      if (property?.key?.name) return `${normalized(init, text)}.${property.key.name}`;
    }
  }
  return normalized(node, text);
}

function captureOf(node) {
  node = unwrap(node);
  if (!node) return false;
  if (node.type === 'BooleanLiteral') return node.value;
  if (node.type === 'ObjectExpression') {
    const capture = node.properties.find(property => property.key?.name === 'capture');
    return unwrap(capture?.value)?.type === 'BooleanLiteral' ? unwrap(capture.value).value : false;
  }
  return false;
}

const optionNamed = (node, name) =>
  unwrap(node)?.type === 'ObjectExpression' && unwrap(node).properties.some(property => property.key?.name === name);

function handlerKind(node) {
  node = unwrap(node);
  if (!node) return 'none';
  if (isFunction(node)) return 'inline';
  if (isCall(node) && calleeName(node.callee) === 'bind') return 'bind';
  if (isCall(node)) return 'call';
  return 'ref';
}

// ---------- the effect analysis ----------

// Analyses one effect body (or componentDidMount) against its cleanup and the component's other cleanups.
function analyzeSetup({ fnPath, cleanup, ownCleanup, component, ctx, deps, isClass, classBody }) {
  const { text, report, kind } = ctx;
  const { returnedNodes, returnedNames } = ownCleanup;
  const cleanupFnNodes = new Set(ownCleanup.fns.map(path => path.node));
  const local = cleanup.own;
  const all = cleanup.component;
  // Whether the value kept in `holder` is released by this effect's cleanup – or, for refs, `this.x` and variables
  // declared outside the effect, by any cleanup of the component.
  const released = (holder, path) => {
    if (holder === 'returned' || holder === 'unknown' || returnedNodes.has(path.node)) return true;
    if (!holder) return false;
    if (returnedNames.has(holder) || local.opaqueRemover) return true;
    const binding = /^[\w$]+$/.test(holder) ? path.scope.getBinding(holder) : null;
    // `const id = setTimeout(…); timerRef.current = id` – the ref is what the cleanup clears.
    const copies = (binding?.referencePaths ?? []).filter(ref => ref.parentPath.isAssignmentExpression() && ref.key === 'right');
    const holders = [holder, ...copies.map(ref => normalized(ref.parent.left, text))];
    return holders.some(name => {
      const nameBinding = name === holder ? binding : null;
      const outside = name !== holder || isRefHolder(name) || (nameBinding && !nameBinding.path.findParent(item => item.node === fnPath.node));
      return [local, ...(outside ? [all] : [])].some(summary => mentions(summary.text, name));
    });
  };

  const adds = [];
  const asyncMarks = [];
  const setterCalls = [];
  let scanRoot = fnPath;
  const visitor = {
    Function(path) {
      if (cleanupFnNodes.has(path.node)) path.skip();
    },
    ClassMethod(path) {
      path.skip();
    },
    // Positions after which code runs asynchronously: the end of an `await …` (not of an awaited setter) and the
    // start of a `.then(` callback.
    AwaitExpression(path) {
      const argument = unwrap(path.node.argument);
      const awaitsSetter = isCall(argument) && argument.callee.type === 'Identifier' && isStateSetter(path, argument.callee.name);
      if (scanRoot === fnPath && !awaitsSetter) asyncMarks.push(path.node.end);
    },
    NewExpression(path) {
      const name = calleeName(path.node.callee);
      if (OBSERVERS.has(name)) {
        const holder = holderOf(path, text);
        const chainedHolder = holder === 'unknown' && isMember(path.parent) ? null : holder;
        if (!released(chainedHolder, path)) {
          report({
            rule: 'observer-not-disconnected',
            severity: 'high',
            node: path.node,
            component,
            key: name,
            message: `${name} created in ${isClass ? 'componentDidMount' : 'an effect'} is never disconnected${chainedHolder ? '' : ' (it is not even stored)'}, so it keeps observing and keeps the component's closure alive after unmount.`,
            fix: `Keep the observer in a variable and call ${chainedHolder ?? 'observer'}.disconnect() in the ${isClass ? 'componentWillUnmount' : 'effect cleanup'}.`
          });
        }
      } else if (CONNECTIONS.has(name)) {
        const holder = holderOf(path, text);
        if (!released(holder, path)) {
          report({
            rule: 'connection-not-closed',
            severity: 'high',
            node: path.node,
            component,
            key: name,
            message: `${name} opened in ${isClass ? 'componentDidMount' : 'an effect'} is never closed, so the connection (and its handlers) stays open after the component unmounts.`,
            fix: `Call ${holder && holder !== 'unknown' ? holder : 'it'}.${/Worker/.test(name) ? 'terminate' : 'close'}() in the ${isClass ? 'componentWillUnmount' : 'effect cleanup'}.`
          });
        }
      }
    },
    'CallExpression|OptionalCallExpression'(path) {
      const callee = unwrap(path.node.callee);
      const name = calleeName(callee);
      if (!name) return;
      const args = path.node.arguments;
      const objectNode = isMember(callee) ? callee.object : null;
      const object = objectNode ? normalized(objectNode, text) : null;
      const rootName = objectNode && unwrap(objectNode).type === 'Identifier' ? unwrap(objectNode).name : null;
      const isRnApi =
        (rootName && RN_APIS.has(rootName)) ||
        /(^|\.)navigation$/.test(object ?? '') ||
        (objectNode && isNativeEmitter(objectNode, path));
      if (isRnApi && /^(addListener|addEventListener)$/.test(name)) {
        if (kind !== 'react-native') return;
        const holder = holderOf(path, text);
        const removedAll = [local, all].some(summary => summary.calls.some(call => call.name === 'removeAllListeners' && call.object === object));
        if (!removedAll && !released(holder, path)) {
          const type = stringValue(args[0]);
          report({
            rule: 'rn-listener-not-removed',
            severity: 'high',
            node: path.node,
            component,
            key: `${object}:${type}`,
            message: `${object}.${name}(${type ? `'${type}'` : '…'}) ${holder ? 'is stored but its subscription is never removed' : 'result is not kept'}, so the listener keeps firing into an unmounted ${component ?? 'component'} (and holds its state in memory).`,
            fix: /navigation$/.test(object)
              ? `Return the unsubscribe function: return ${object}.addListener(…) (or call it in the cleanup).`
              : `Keep the subscription (const sub = ${object}.${name}(…)) and call sub.remove() in the ${isClass ? 'componentWillUnmount' : 'effect cleanup'}.`
          });
        }
        return;
      }
      if (name === 'addEventListener' && objectNode) {
        adds.push({ root: scanRoot, path, object: targetText(objectNode, path, text), objectNode, type: args[0], handler: args[1], options: args[2] });
        return;
      }
      if (SUBSCRIBE_METHODS.has(name) && objectNode && looksLikeSubscription(name, args, objectNode)) {
        if (createdInside(objectNode, path, scanRoot, true)) return;
        const holder = holderOf(path, text);
        const eventName = stringValue(args[0]);
        const alias = targetText(objectNode, path, text);
        // Removing the handler, or tearing the whole emitter down (`player.dispose()`), both end the subscription.
        const removedOnTarget = [local, all].some(summary =>
          summary.calls.some(
            call =>
              (/^(off|removeListener|removeEventListener|unsubscribe|removeAllListeners|unlisten|remove)$/.test(call.name ?? '') &&
                (call.object === object || (eventName && stringValue(call.node.arguments[0]) === eventName))) ||
              (REMOVER_NAME.test(call.name ?? '') && [call.object, call.alias].some(item => item && (item === object || item === alias)))
          )
        );
        if (!removedOnTarget && !released(holder, path)) {
          const isStore = name === 'subscribe' && /store$/i.test(object);
          report({
            rule: 'subscription-not-removed',
            severity: isStore ? 'high' : 'medium',
            node: path.node,
            component,
            key: `${object}.${name}:${eventName ?? ''}`,
            message: `${object}.${name}(${eventName ? `'${eventName}'` : '…'}) in ${isClass ? 'componentDidMount' : 'an effect'} is never undone, so the callback keeps running after unmount${isStore ? ' on every Redux dispatch' : ''} and keeps the component in memory.`,
            fix:
              name === 'subscribe' || name === 'listen'
                ? `Keep the returned unsubscribe function and call it in the ${isClass ? 'componentWillUnmount' : 'cleanup'} (or return it from the effect).`
                : `Call ${object}.${name === 'on' ? 'off' : 'removeListener'}(…) with the same handler in the ${isClass ? 'componentWillUnmount' : 'cleanup'}.`
          });
        }
        return;
      }
      const timerName = callee.type === 'Identifier' || /^(window|globalThis|global)$/.test(object ?? '') ? name : null;
      if (timerName === 'setInterval') {
        const holder = holderOf(path, text);
        const cleared = released(holder, path);
        if (!cleared) {
          const selfClearing = /clearInterval\s*\(/.test(sourceOf(args[0], text));
          report({
            rule: 'interval-not-cleared',
            severity: selfClearing ? 'medium' : 'high',
            node: path.node,
            component,
            key: holder ?? '',
            message: holder
              ? `setInterval stored in ${holder} is not cleared in the ${isClass ? 'componentWillUnmount' : 'effect cleanup'}, so it keeps ticking (and setting state) after unmount${selfClearing ? ' until its own stop condition is met' : ''}.`
              : `setInterval's id is not stored, so it can never be cleared and keeps running after the component unmounts${selfClearing ? ' until its own stop condition is met' : ''}.`,
            fix: `Store the id and call clearInterval(id) in the ${isClass ? 'componentWillUnmount' : 'effect cleanup'}.`
          });
        }
        return;
      }
      if (timerName === 'setTimeout' && path.getFunctionParent()?.node === fnPath.node) {
        const holder = holderOf(path, text);
        if (holder && holder !== 'unknown' && holder !== 'returned') {
          if (!released(holder, path)) {
            report({
              rule: 'timeout-not-cleared',
              severity: 'low',
              node: path.node,
              component,
              key: holder,
              message: `setTimeout stored in ${holder} is never cleared, so it can still fire after the component unmounts (or after the effect re-runs).`,
              fix: `Call clearTimeout(${holder}) in the ${isClass ? 'componentWillUnmount' : 'effect cleanup'}.`
            });
          }
        } else if (holder === null && !local.assigns && callsSetter(path.get('arguments.0'), isClass)) {
          report({
            rule: 'timeout-not-cleared',
            severity: 'low',
            node: path.node,
            component,
            key: 'setter',
            message: `setTimeout sets state but is never cleared, so it can fire after unmount or after the effect re-ran and apply a stale update.`,
            fix: `Keep the id (const id = setTimeout(…)) and return () => clearTimeout(id) from the effect.`
          });
        }
        return;
      }
      if (timerName === 'requestAnimationFrame' && isRafLoop(path)) {
        const cancelled = [local, all].some(summary => /cancelAnimationFrame\s*\(/.test(summary.text)) || local.assigns > 0 || local.opaqueRemover;
        if (!cancelled) {
          report({
            rule: 'raf-not-cancelled',
            severity: 'medium',
            node: path.node,
            component,
            key: '',
            message: 'A requestAnimationFrame loop is started but never cancelled, so it keeps running every frame after the component unmounts.',
            fix: 'Keep the latest frame id and call cancelAnimationFrame(id) in the cleanup (or stop the loop with a flag set in the cleanup).'
          });
        }
        return;
      }
      if (scanRoot !== fnPath) return;
      if (callee.type === 'Identifier' && isStateSetter(path, callee.name)) setterCalls.push(path);
      if (name === 'then') asyncMarks.push(callee.end);
    }
  };
  fnPath.traverse(visitor);
  // Functions the effect calls (useCallback helpers, component functions) start things on its behalf.
  for (const extra of calledFunctions(fnPath, cleanupFnNodes)) {
    scanRoot = extra;
    extra.traverse(visitor);
  }

  for (const add of adds) checkListener(add, { local, all, ctx, component, fnPath, isClass });

  if (!isClass && deps && deps.type === 'ArrayExpression' && deps.elements.length > 0 && asyncMarks.length && setterCalls.length) {
    const effectText = sourceOf(fnPath.node, text);
    const guarded = local.assigns > 0 || /AbortController|\.abort\(|signal/.test(effectText) || local.opaqueRemover;
    // Setters inside a setTimeout callback belong to timeout-not-cleared.
    const inTimeout = call => Boolean(call.findParent(item => item.isCallExpression() && calleeName(item.node.callee) === 'setTimeout'));
    const after = setterCalls.find(call => asyncMarks.some(start => start < call.node.start) && !inTimeout(call));
    if (!guarded && after) {
      report({
        rule: 'state-after-unmount',
        severity: 'low',
        node: after.node,
        component,
        key: sourceOf(after.node.callee, text),
        message: `${sourceOf(after.node.callee, text)} runs after an awaited call without a cancelled flag or AbortController: when the dependencies change quickly, an older run can finish last and overwrite the newer state (a race; after unmount the update is simply dropped).`,
        fix: 'Set `let cancelled = false` in the effect, `return () => { cancelled = true }`, and skip the update when cancelled (or abort the request).'
      });
    }
  }
}

// Local functions called from the effect body (one level): declared outside the effect, e.g. with useCallback.
// Only calls whose result is dropped: a helper whose result is kept usually returns its own cleanup.
function calledFunctions(fnPath, cleanupFnNodes) {
  const found = new Map();
  fnPath.traverse({
    Function(path) {
      if (cleanupFnNodes.has(path.node)) path.skip();
    },
    CallExpression(path) {
      const callee = path.node.callee;
      if (callee.type !== 'Identifier' || !path.parentPath.isExpressionStatement()) return;
      const binding = path.scope.getBinding(callee.name);
      if (!binding || binding.path.findParent(item => item.node === fnPath.node)) return;
      let target = null;
      if (binding.path.isFunctionDeclaration()) target = binding.path;
      else if (binding.path.isVariableDeclarator()) {
        const init = unwrap(binding.path.node.init);
        if (isFunction(init)) target = binding.path.get('init');
        else if (isUseCallback(init)) target = binding.path.get('init.arguments.0');
      }
      if (target?.node && target.isFunction() && !found.has(target.node) && !cleanupOf(target).fns.length) found.set(target.node, target);
    }
  });
  return [...found.values()];
}

function isNativeEmitter(objectNode, path) {
  const node = unwrap(objectNode);
  if (node.type === 'NewExpression') return calleeName(node.callee) === 'NativeEventEmitter';
  if (node.type !== 'Identifier') return false;
  const binding = path.scope.getBinding(node.name);
  const init = binding?.path.isVariableDeclarator() ? unwrap(binding.path.node.init) : null;
  return init?.type === 'NewExpression' && calleeName(init.callee) === 'NativeEventEmitter';
}

// `.on('event', handler)` / `.subscribe(fn)`: the shape of an event subscription, not e.g. `router.on` config.
function looksLikeSubscription(name, args, objectNode) {
  const object = unwrap(objectNode);
  if (object.type === 'ThisExpression') return false;
  if (name === 'subscribe' || name === 'listen') return args.length >= 1;
  if (args.length < 2) return false;
  const handler = unwrap(args[1]);
  return isFunction(handler) || handler.type === 'Identifier' || isMember(handler);
}

function callsSetter(callbackPath, isClass) {
  const node = unwrap(callbackPath?.node);
  if (!isFunction(node)) return false;
  let found = false;
  callbackPath.traverse({
    'CallExpression|OptionalCallExpression'(path) {
      const callee = unwrap(path.node.callee);
      if (callee.type === 'Identifier' && isStateSetter(path, callee.name)) found = true;
      if (isClass && isMember(callee) && calleeName(callee) === 'setState') found = true;
    }
  });
  return found;
}

// requestAnimationFrame(tick) inside the function `tick` itself, unconditionally: a loop that only a cancel or a
// flag stops. A conditional re-schedule (`if (progress < 1)`) is a finite animation and is skipped.
function isRafLoop(path) {
  const arg = unwrap(path.node.arguments[0]);
  if (arg?.type !== 'Identifier') return false;
  let fn = path.getFunctionParent();
  while (fn) {
    const node = fn.node;
    const name = node.id?.name ?? (fn.parentPath?.isVariableDeclarator() ? fn.parentPath.node.id.name : null);
    if (name === arg.name) {
      const conditional = path.findParent(item => item.node === fn.node || /^(IfStatement|ConditionalExpression|LogicalExpression)$/.test(item.node.type));
      const earlyReturn = fn.node.body.type === 'BlockStatement' && fn.node.body.body.some(statement => statement.type === 'IfStatement' && containsReturn(statement));
      return conditional?.node === fn.node && !earlyReturn;
    }
    fn = fn.getFunctionParent();
  }
  return false;
}

const containsReturn = node =>
  node?.type === 'ReturnStatement' || (node?.type === 'IfStatement' ? containsReturn(node.consequent) || containsReturn(node.alternate) : node?.type === 'BlockStatement' && node.body.some(containsReturn));

function checkListener(add, { local, all, ctx, component, fnPath, isClass }) {
  const { text, report } = ctx;
  const type = stringValue(add.type) ?? normalized(add.type, text);
  if (optionNamed(add.options, 'once')) return;
  if (createdInside(add.objectNode, add.path, add.root, false)) return;
  const handlerText = normalized(add.handler, text);
  const removes = [local, all].flatMap(summary =>
    summary.calls
      .filter(call => call.name === 'removeEventListener')
      .map(call => ({ ...call, type: stringValue(call.node.arguments[0]) ?? normalized(call.node.arguments[0], text) }))
  );
  const sameType = removes.filter(call => call.type === type);
  const remove =
    sameType.find(call => targetText(unwrap(call.node.callee).object, call.path, text) === add.object) ??
    sameType.find(call => normalized(call.node.arguments[1], text) === handlerText);
  const where = isClass ? 'componentWillUnmount' : 'effect cleanup';
  if (optionNamed(add.options, 'signal')) {
    if (![local, all].some(summary => /\.abort\s*\(/.test(summary.text)) && !local.opaqueRemover && !remove) {
      report({
        rule: 'listener-not-removed',
        severity: HIGH_TARGETS.test(add.object) ? 'high' : 'medium',
        node: add.path.node,
        component,
        key: `${add.object}:${type}`,
        message: `'${type}' listener on ${add.object} uses an AbortSignal that is never aborted, so it stays attached after unmount.`,
        fix: `Call controller.abort() in the ${where}.`
      });
    }
    return;
  }
  if (!remove) {
    const removedAll = [local, all].some(summary => summary.calls.some(call => call.name === 'removeAllListeners'));
    if (removedAll || local.opaqueRemover) return;
    report({
      rule: 'listener-not-removed',
      severity: HIGH_TARGETS.test(add.object) ? 'high' : 'medium',
      node: add.path.node,
      component,
      key: `${add.object}:${type}`,
      message: `'${type}' listener added to ${add.object} is never removed, so every mount adds another handler that keeps running (and keeps the component's closure in memory) after unmount.`,
      fix: `Call ${add.object}.removeEventListener('${type}', ${handlerKind(add.handler) === 'ref' ? handlerText : 'handler'}) in the ${where}${handlerKind(add.handler) === 'ref' ? '' : ' (keep the handler in a variable first)'}.`
    });
    return;
  }
  const addKind = handlerKind(add.handler);
  const removeKind = handlerKind(remove.node.arguments[1]);
  if (removeKind === 'inline' || removeKind === 'bind' || addKind === 'inline' || addKind === 'bind') {
    // Reported once per remove call (see differentReferenceRemoves) when the remove itself is inline/bind.
    if (removeKind !== 'inline' && removeKind !== 'bind') {
      report({
        rule: 'listener-remove-different-reference',
        severity: 'high',
        node: remove.node,
        component,
        key: `${add.object}:${type}`,
        message: `removeEventListener('${type}') gets a different function than the one that was added (${addKind === 'bind' ? '.bind() creates a new function' : 'the added handler is an inline function'}), so it removes nothing and the listener leaks.`,
        fix: 'Create the handler once (a named function or a variable), pass that same reference to add and remove.'
      });
    }
    return;
  }
  if (captureOf(add.options) && !captureOf(remove.node.arguments[2])) {
    report({
      rule: 'listener-capture-mismatch',
      severity: 'medium',
      node: remove.node,
      component,
      key: `${add.object}:${type}`,
      message: `'${type}' listener is added with capture: true but removed without it, so the browser treats it as a different listener and never removes it.`,
      fix: 'Pass the same capture option to removeEventListener (true or { capture: true }).'
    });
  }
}

// ---------- entry points used by the file walker ----------

// Effect hooks are grouped per component so a ref-held resource cleaned up by a sibling effect is not flagged.
export function analyzeComponentEffects(effects, ctx) {
  const byOwner = new Map();
  for (const effect of effects) {
    const list = byOwner.get(effect.ownerNode) ?? [];
    list.push(effect);
    byOwner.set(effect.ownerNode, list);
  }
  for (const list of byOwner.values()) {
    // useUnmount(fn): fn itself is cleanup code for the whole component.
    const prepared = list.map(effect => {
      if (effect.unmount) return { ...effect, summary: summarizeCleanup([effect.fnPath], ctx.text) };
      const own = cleanupOf(effect.fnPath);
      return { ...effect, own, summary: summarizeCleanup(own.fns, ctx.text) };
    });
    const component = summarizeAll(prepared.map(item => item.summary));
    for (const item of prepared) {
      if (item.unmount) continue;
      analyzeSetup({
        fnPath: item.fnPath,
        ownCleanup: item.own,
        cleanup: { own: item.summary, component },
        component: item.component,
        ctx,
        deps: item.deps
      });
    }
  }
}

function summarizeAll(summaries) {
  return {
    calls: summaries.flatMap(summary => summary.calls),
    text: summaries.map(summary => summary.text).join('\n'),
    assigns: summaries.reduce((sum, summary) => sum + summary.assigns, 0),
    opaqueRemover: false
  };
}

export function analyzeClassComponent(classPath, component, ctx) {
  const body = classPath.get('body');
  const method = name =>
    body.get('body').find(item => (item.isClassMethod() || item.isClassProperty()) && item.node.key?.name === name && !item.node.computed);
  const mount = method('componentDidMount');
  if (!mount) return;
  const mountFn = mount.isClassProperty() ? mount.get('value') : mount;
  if (!mountFn?.node || !(mountFn.isFunction() || mountFn.isClassMethod())) return;
  const unmount = method('componentWillUnmount');
  const unmountFn = unmount ? (unmount.isClassProperty() ? unmount.get('value') : unmount) : null;
  const summary = summarizeCleanup(unmountFn?.node ? [unmountFn] : [], ctx.text, body);
  analyzeSetup({
    fnPath: mountFn,
    ownCleanup: { fns: [], returnedNodes: new Set(), returnedNames: new Set() },
    cleanup: { own: summary, component: summary },
    component,
    ctx,
    deps: null,
    isClass: true,
    classBody: body
  });
}

// removeEventListener(type, () => …) / (type, this.x.bind(this)) never removes anything, wherever it is.
export function checkInlineRemove(path, component, ctx) {
  const handler = path.node.arguments[1];
  const kind = handlerKind(handler);
  if (kind !== 'inline' && kind !== 'bind') return;
  const type = stringValue(path.node.arguments[0]) ?? normalized(path.node.arguments[0], ctx.text);
  ctx.report({
    rule: 'listener-remove-different-reference',
    severity: 'high',
    node: path.node,
    component,
    key: `inline:${type}`,
    message: `removeEventListener('${type}') is given ${kind === 'bind' ? 'a fresh .bind() result' : 'a new inline function'}, which was never added, so it removes nothing and the original listener leaks.`,
    fix: 'Keep the handler in a variable (or bind it once in the constructor) and pass that same reference to add and remove.'
  });
}

// window.X = … inside a component, hook or effect: survives the component and every remount.
export function checkGlobalAssignment(path, component, ctx) {
  const left = unwrap(path.node.left);
  if (!isMember(left) || left.computed) return;
  const object = unwrap(left.object);
  if (object.type !== 'Identifier' || !/^(window|globalThis|global)$/.test(object.name)) return;
  if (path.scope.getBinding(object.name)) return; // a local variable called `global`
  const property = left.property.name;
  if (/^(location|name|status)$/.test(property)) return;
  // Resetting (`= null`, `delete window.x`) is the cleanup of an earlier assignment, not a new leak.
  const right = unwrap(path.node.right);
  if (right.type === 'NullLiteral' || (right.type === 'Identifier' && right.name === 'undefined')) return;
  const escaped = property.replace(/\$/g, '\\$');
  if (new RegExp(`(delete\\s+${object.name}\\.${escaped}\\b|${object.name}\\.${escaped}\\s*=\\s*(null|undefined)\\b)`).test(ctx.text)) return;
  ctx.report({
    rule: 'global-assignment',
    severity: 'low',
    node: path.node,
    component,
    key: property,
    message: `${object.name}.${property} is assigned inside ${component ?? 'a component'}, so whatever it references outlives the component (and is overwritten by every instance).`,
    fix: 'Keep the value in a ref, context or module, or delete it in the effect cleanup if it must be global.'
  });
}

const isSmallValue = node =>
  /^(NumericLiteral|StringLiteral|BooleanLiteral|NullLiteral|TemplateLiteral|BinaryExpression|UnaryExpression|UpdateExpression)$/.test(unwrap(node)?.type ?? '');

// A module-level Map/Set/array/object that functions add to and nothing ever removes from: it lives (and grows)
// for the whole session.
export function checkModuleCaches(programPath, ctx) {
  for (const statement of programPath.get('body')) {
    const declaration = statement.isExportNamedDeclaration() ? null : statement;
    if (!declaration?.isVariableDeclaration()) continue;
    for (const declarator of declaration.get('declarations')) {
      const id = declarator.node.id;
      const init = unwrap(declarator.node.init);
      if (id.type !== 'Identifier' || !init) continue;
      const shape =
        init.type === 'NewExpression' && /^(Map|Set)$/.test(calleeName(init.callee) ?? '')
          ? calleeName(init.callee)
          : init.type === 'ArrayExpression' && init.elements.length === 0
            ? 'array'
            : init.type === 'ObjectExpression' && init.properties.length === 0
              ? 'object'
              : null;
      if (!shape) continue;
      const binding = declarator.scope.getBinding(id.name);
      if (!binding || binding.constantViolations.length) continue;
      let grows = null;
      let heavyValues = false; // objects, arrays, promises, functions… (numbers/strings/booleans cost little)
      let shrinks = false;
      for (const ref of binding.referencePaths) {
        const parent = ref.parentPath;
        const inFunction = Boolean(ref.getFunctionParent());
        if (parent.isMemberExpression() && parent.node.object === ref.node) {
          const prop = parent.node.computed ? null : parent.node.property.name;
          const call = parent.parentPath;
          const isCalled = call.isCallExpression() && call.node.callee === parent.node;
          if (isCalled && /^(delete|clear|splice|pop|shift|filter)$/.test(prop)) shrinks = true;
          else if (/^(size|length)$/.test(prop) && !(parent.parentPath.isAssignmentExpression() && parent.key === 'left')) shrinks = true; // bounded by size
          else if (prop === 'length' && parent.parentPath.isAssignmentExpression()) shrinks = true;
          else if (isCalled && /^(set|add|push|unshift)$/.test(prop) && inFunction && shape !== 'object') {
            grows ??= parent.node;
            const args = call.node.arguments;
            heavyValues ||= !isSmallValue(prop === 'set' ? args[1] : args[0]);
          }
          else if (parent.node.computed && parent.parentPath.isAssignmentExpression() && parent.key === 'left' && inFunction) {
            if (shape === 'object' && unwrap(parent.node.property).type !== 'StringLiteral') {
              grows ??= parent.node;
              heavyValues ||= !isSmallValue(parent.parent.right);
            }
          } else if (parent.parentPath.isUnaryExpression({ operator: 'delete' })) shrinks = true;
        } else if (!parent.isMemberExpression()) {
          // Passed to another function, exported or returned: something we cannot see may clear it.
          shrinks = true;
        }
      }
      // `new Map<string, number>()`: the declared value type tells us the entries are small.
      const typeArgs = init.typeParameters?.params ?? [];
      const valueType = typeArgs[shape === 'Map' ? 1 : 0]?.type;
      if (/^TS(String|Number|Boolean)Keyword$/.test(valueType ?? '')) heavyValues = false;
      if (grows && !shrinks) {
        ctx.report({
          rule: 'module-cache-grows',
          // An array that is only pushed to grows with every call (listener lists, logs): medium. A Map/object/Set
          // grows with every distinct key, which is often a bounded set (screens, sports, colours): low, since
          // whether the keys are bounded is not visible statically.
          severity: shape === 'array' && heavyValues ? 'medium' : 'low',
          node: declarator.node,
          component: null,
          key: id.name,
          message:
            shape === 'array'
              ? `Module-level array \`${id.name}\` is pushed to (line ${lineOf(grows)}) but never shrunk, so it lives for the whole session and grows with every call (with everything it references).`
              : `Module-level ${shape === 'object' ? 'object' : shape} \`${id.name}\` is added to (line ${lineOf(grows)}) but nothing ever deletes from or clears it, so it lives for the whole session and grows with every distinct key (with everything it references).`,
          fix: 'Bound it (LRU / max size), delete entries when they are no longer needed, or use a WeakMap keyed by the owning object.'
        });
      }
    }
  }
}

