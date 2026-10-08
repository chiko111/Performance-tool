// Redux selector rules. useSelector re-runs every selector on every dispatch and re-renders when the result is
// not === the previous one, so a selector that builds a new object/array re-renders its component every time.
import { calleeName, isCall, isFunction, isMember, lineOf, sourceOf, unwrap } from './ast.mjs';

const NEW_METHODS = new Set(['map', 'filter', 'slice', 'concat', 'flatMap', 'flat', 'toSorted', 'toReversed', 'toSpliced', 'split']);
const NEW_STATICS = /^(Object\.(keys|values|entries|assign|fromEntries)|Array\.(from|of))$/;
const MEMO_FACTORIES = new Set(['createSelector', 'createDraftSafeSelector', 'createStructuredSelector', 'createCachedSelector']);

export const isSelectorHook = name => Boolean(name) && /^use\w*Selector$/.test(name) && !/Shallow|Equal|Memo/i.test(name);

// 'always' | 'fallback' (only when a value is missing: `x ?? []`) | null. `why` explains the shape for the message.
export function newReferenceKind(node, scopePath, depth = 0) {
  node = unwrap(node);
  if (!node || depth > 3) return null;
  switch (node.type) {
    case 'ObjectExpression':
      return { kind: 'always', why: 'an object literal' };
    case 'ArrayExpression':
      return { kind: 'always', why: 'an array literal' };
    case 'NewExpression':
      return { kind: 'always', why: `new ${calleeName(node.callee) ?? '…'}()` };
    case 'LogicalExpression': {
      const left = newReferenceKind(node.left, scopePath, depth + 1);
      if (left?.kind === 'always') return left;
      const right = newReferenceKind(node.right, scopePath, depth + 1);
      return right ? { kind: 'fallback', why: `a fallback to ${right.why} (${node.operator})` } : null;
    }
    case 'ConditionalExpression': {
      const yes = newReferenceKind(node.consequent, scopePath, depth + 1);
      const no = newReferenceKind(node.alternate, scopePath, depth + 1);
      if (yes?.kind === 'always' && no?.kind === 'always') return yes;
      return yes || no ? { kind: 'fallback', why: (yes ?? no).why.replace(/^/, 'in one branch ') } : null;
    }
    case 'Identifier': {
      const binding = scopePath?.scope.getBinding(node.name);
      if (!binding?.path.isVariableDeclarator() || binding.kind !== 'const' || !scopePath.findParent) return null;
      const insideSelector = binding.path.findParent(item => item.node === scopePath.node);
      return insideSelector ? newReferenceKind(binding.path.node.init, scopePath, depth + 1) : null;
    }
    case 'CallExpression':
    case 'OptionalCallExpression': {
      const callee = unwrap(node.callee);
      if (!isMember(callee)) return null;
      const name = calleeName(callee);
      if (callee.object.type === 'Identifier' && NEW_STATICS.test(`${callee.object.name}.${name}`)) {
        return { kind: 'always', why: `${callee.object.name}.${name}()` };
      }
      if (NEW_METHODS.has(name)) return { kind: 'always', why: `.${name}()` };
      if (name === 'reduce') {
        const initial = unwrap(node.arguments[1]);
        if (initial && (initial.type === 'ObjectExpression' || initial.type === 'ArrayExpression')) return { kind: 'always', why: '.reduce() into a new object' };
      }
      return null;
    }
    default:
      return null;
  }
}

// Expressions a function returns (arrow body or its own return statements).
export function returnedExpressions(fnPath) {
  const node = fnPath.node;
  if (node.body.type !== 'BlockStatement') return [fnPath.get('body')];
  const found = [];
  fnPath.get('body').traverse({
    Function(path) {
      path.skip();
    },
    ReturnStatement(path) {
      if (path.node.argument) found.push(path.get('argument'));
    }
  });
  return found;
}

function selectorFunctionKind(fnPath) {
  let worst = null;
  for (const expression of returnedExpressions(fnPath)) {
    const kind = newReferenceKind(expression.node, fnPath);
    if (kind && (!worst || (kind.kind === 'always' && worst.kind !== 'always'))) worst = kind;
  }
  return worst;
}

// Module-level selector functions of a file: name -> { kind, why, line } for those that build new references,
// and { memoized: true } for createSelector results.
export function collectSelectorDefs(programPath) {
  const defs = new Map();
  for (let statement of programPath.get('body')) {
    if (statement.isExportNamedDeclaration() && statement.node.declaration) statement = statement.get('declaration');
    if (statement.isFunctionDeclaration() && statement.node.id) {
      defs.set(statement.node.id.name, { line: lineOf(statement.node), ...selectorFunctionKind(statement) });
    } else if (statement.isVariableDeclaration()) {
      for (const declarator of statement.get('declarations')) {
        if (declarator.node.id.type !== 'Identifier') continue;
        const init = declarator.get('init');
        const node = unwrap(init.node);
        if (isFunction(node)) {
          defs.set(declarator.node.id.name, { line: lineOf(node), ...selectorFunctionKind(init.isFunction() ? init : init.get('expression')) });
        } else if (isCall(node) && MEMO_FACTORIES.has(calleeName(node.callee))) {
          defs.set(declarator.node.id.name, { line: lineOf(node), memoized: true });
        }
      }
    }
  }
  return defs;
}

// The selector given to a selector hook: inline function or a reference to a selector defined elsewhere.
export function analyzeSelectorCall(path, ctx, component, defs) {
  const args = path.node.arguments;
  if (!args.length) return;
  // An equality function (shallowEqual, isEqual …) as 2nd argument already handles new references.
  if (args[1] && !(unwrap(args[1]).type === 'Identifier' && unwrap(args[1]).name === 'undefined')) return;
  const hook = calleeName(path.node.callee);
  const selectorPath = path.get('arguments.0');
  const selector = unwrap(selectorPath.node);
  const declarator = path.parentPath.isVariableDeclarator() ? path.parentPath : null;
  const callNode = path.node; // not `path`: deferred reports must not keep the whole AST alive
  const reportNew = (kind, via) =>
    ctx.report({
      rule: 'selector-new-reference',
      severity: kind.kind === 'always' ? 'high' : 'medium',
      node: callNode,
      component,
      key: `${hook}:${via ?? ''}`,
      message:
        kind.kind === 'always'
          ? `${hook} in ${component ?? 'this component'} returns ${kind.why}${via ? ` (from ${via})` : ''}, a new reference on every call, so the component re-renders on every Redux dispatch.`
          : `${hook} in ${component ?? 'this component'} returns ${kind.why}${via ? ` (from ${via})` : ''}: while that value is missing it is a new reference every time, so the component re-renders on every dispatch.`,
      fix:
        kind.kind === 'always'
          ? 'Select the raw state and derive with useMemo, memoize the selector with createSelector, or pass shallowEqual as the 2nd argument.'
          : 'Use a constant fallback defined outside the component (const EMPTY = []) instead of a new literal.'
    });

  if (isFunction(selector)) {
    const fnPath = selectorPath.isFunction() ? selectorPath : selectorPath.get('expression');
    const param = selector.params[0]?.type === 'Identifier' ? selector.params[0].name : null;
    for (const expressionPath of returnedExpressions(fnPath)) {
      const expression = unwrap(expressionPath.node);
      const kind = newReferenceKind(expression, fnPath);
      if (kind) return reportNew(kind);
      if (param && expression.type === 'Identifier' && expression.name === param) {
        return ctx.report({
          rule: 'selector-whole-state',
          severity: 'medium',
          node: path.node,
          component,
          key: hook,
          message: `${hook}(state => state) in ${component ?? 'this component'} subscribes to the whole store, so it re-renders on every state change.`,
          fix: 'Select only the fields the component reads (one useSelector per value).'
        });
      }
      if (param && isMember(expression) && unwrap(expression.object).type === 'Identifier' && unwrap(expression.object).name === param && declarator?.node.id.type === 'ObjectPattern') {
        const fields = declarator.node.id.properties.map(property => property.key?.name).filter(Boolean);
        return ctx.report({
          rule: 'selector-whole-state',
          severity: 'medium',
          node: path.node,
          component,
          key: `${hook}:${sourceOf(expression, ctx.text)}`,
          message: `${component ?? 'This component'} selects the whole ${sourceOf(expression, ctx.text)} slice but only uses ${fields.join(', ') || 'part of it'}, so it re-renders whenever anything in that slice changes.`,
          fix: `Select just ${fields.length ? fields.map(field => `${sourceOf(expression, ctx.text)}.${field}`).join(' / ') : 'the needed fields'} (one useSelector each).`
        });
      }
      // `state => selectThing(state, id)`: judged later from the definition of selectThing.
      if (isCall(expression) && unwrap(expression.callee).type === 'Identifier') {
        ctx.deferSelector({ path, name: unwrap(expression.callee).name, component, hook, reportNew });
      }
    }
    return;
  }
  if (selector.type === 'Identifier') ctx.deferSelector({ path, name: selector.name, component, hook, reportNew });
}

// Where a selector passed by name comes from: { local } (module level of this file) or { source, imported }.
export function selectorReference(path, name) {
  const binding = path.scope.getBinding(name);
  if (binding?.path.isImportSpecifier()) {
    return { source: binding.path.parent.source.value, imported: binding.path.node.imported.name ?? binding.path.node.imported.value };
  }
  return binding && binding.scope.path.isProgram() ? { local: name } : null;
}

// createSelector(input, x => x): the memoization returns the input unchanged, so it only adds overhead.
export function checkIdentityMemo(path, ctx, component) {
  const args = path.node.arguments;
  const last = unwrap(args[args.length - 1]);
  if (!isFunction(last) || last.params.length !== 1 || last.params[0].type !== 'Identifier') return;
  const body = last.body.type === 'BlockStatement' ? (last.body.body.length === 1 && last.body.body[0].type === 'ReturnStatement' ? last.body.body[0].argument : null) : last.body;
  if (unwrap(body)?.type !== 'Identifier' || unwrap(body).name !== last.params[0].name) return;
  ctx.report({
    rule: 'selector-identity-memo',
    severity: 'medium',
    node: path.node,
    component,
    key: calleeName(path.node.callee),
    message: `${calleeName(path.node.callee)} has an identity result function (${last.params[0].name} => ${last.params[0].name}), so the memoization only adds work and returns the input unchanged.`,
    fix: 'Use the input selector directly, or move the actual derivation into the result function.'
  });
}

// createSelector()/makeSelectX() called while rendering: every render gets a fresh memo cache, so it never hits.
export function checkCreatedInRender(path, ctx, owner) {
  if (!owner) return;
  const name = calleeName(path.node.callee);
  const isFactory = MEMO_FACTORIES.has(name) || /^make(Select|\w*Selector$)/.test(name ?? '');
  if (!isFactory) return;
  let current = path.parentPath;
  while (current && current.node !== owner.path.node) {
    if (isCall(current.node) && /^(useMemo|useCallback|useState|useRef|useConst|useCreation)$/.test(calleeName(current.node.callee) ?? '')) return;
    if (current.isFunction()) {
      // Allowed only directly in render or inside the selector passed to a selector hook (runs every dispatch).
      const call = current.parentPath;
      if (!(isCall(call?.node) && /Selector$/.test(calleeName(call.node.callee) ?? ''))) return;
    }
    current = current.parentPath;
  }
  ctx.report({
    rule: 'selector-created-in-render',
    severity: 'high',
    node: path.node,
    component: owner.name,
    key: name,
    message: `${name}() runs on every render of ${owner.name}, creating a new memoized selector each time, so its cache never hits and it recomputes on every dispatch.`,
    fix: `Create it once: useMemo(() => ${name}(…), [deps]) or define it at module level.`
  });
}

export { MEMO_FACTORIES };
