// One Babel parse + traversal per source file feeds every JavaScript-based section: leaks, selectors, context,
// the import graph, package usage and CSS-module class usage. Each section's handlers are guarded separately so a
// bug in one rule only costs that section that file.
import { calleeName, isCall, isFunction, lineOf, normalized, ownerPath, sourceOf, stringValue, unwrap } from './ast.mjs';
import { parseSource } from './common.mjs';
import {
  analyzeClassComponent,
  analyzeComponentEffects,
  checkGlobalAssignment,
  checkInlineRemove,
  checkModuleCaches,
  isEffectCall,
  isEffectWrapper,
  isUnmountHook,
  returnsCleanup,
  wrapperSemantics
} from './leaks.mjs';
import { packageNameOf } from './resolve.mjs';
import {
  MEMO_FACTORIES,
  analyzeSelectorCall,
  checkCreatedInRender,
  checkIdentityMemo,
  collectSelectorDefs,
  isSelectorHook,
  selectorReference
} from './selectors.mjs';

const CSS_MODULE = /\.module\.(s?css|sass|less)$/;
const COMPONENT_BASE = /^(React\.)?(Pure)?Component$/;

// The function a variable refers to: `function f() {}`, `const f = () => {}` or `const f = useCallback(() => {}, [])`.
function functionOf(identifierPath) {
  const binding = identifierPath.scope.getBinding(identifierPath.node.name);
  if (binding?.path.isFunctionDeclaration()) return binding.path;
  if (!binding?.path.isVariableDeclarator()) return null;
  const init = binding.path.get('init');
  return init.node ? init : null;
}

function cssModuleUsage(path, binding, usage) {
  for (const ref of binding.referencePaths) {
    let current = ref;
    while (/^(TSAsExpression|TSNonNullExpression|ParenthesizedExpression)$/.test(current.parentPath.node.type)) current = current.parentPath;
    const parent = current.parentPath;
    if ((parent.isMemberExpression() || parent.isOptionalMemberExpression()) && parent.node.object === current.node) {
      const name = parent.node.computed ? stringValue(parent.node.property) : parent.node.property.name;
      if (name == null) usage.dynamic = true;
      else if (!usage.used.has(name)) usage.used.set(name, lineOf(parent.node));
    } else if (parent.isVariableDeclarator() && parent.node.id.type === 'ObjectPattern') {
      for (const property of parent.node.id.properties) {
        if (property.type === 'RestElement' || property.computed) usage.dynamic = true;
        else if (!usage.used.has(property.key.name ?? property.key.value)) usage.used.set(property.key.name ?? property.key.value, lineOf(property));
      }
    } else usage.dynamic = true; // passed on as a whole (prop, spread, function argument): any class may be used
  }
}

export function analyzeJsFile({ babel, file, relative, text, kind, sections }) {
  const result = {
    findings: { leaks: [], selectors: [], context: [] },
    errors: [],
    imports: [], // { spec, line, dynamic, typeOnly }
    reexports: [], // { spec, names: [{ local, exported }] | null (export *) }
    cssModules: [], // { spec, line, used: Map(name -> line), dynamic }
    selectorDefs: new Map(),
    deferredSelectors: [],
    contextCandidates: [],
    wrapperCalls: [], // effect-wrapper calls whose callback returns a cleanup
    effectWrappers: new Map(), // custom effect hooks defined here: name -> 'discards' | 'passes'
    barrel: false
  };
  const lines = text.split('\n');
  const failed = new Set();
  const guard = (section, fn) => (...args) => {
    if (failed.has(section)) return;
    try {
      fn(...args);
    } catch (error) {
      failed.add(section);
      result.errors.push({ section, file: relative, message: `rule crashed: ${error.message.split('\n')[0]}` });
    }
  };
  const reporter = section => ({ rule, severity, node, component, key, message, fix }) => {
    const line = lineOf(node);
    const snippet = line ? lines[line - 1] : null;
    result.findings[section].push({ rule, severity, file: relative, line, component: component ?? null, key, message, fix, snippet });
  };
  const leakCtx = { text, kind, report: reporter('leaks') };
  const selectorCtx = {
    text,
    report: reporter('selectors'),
    // Judged after every file is parsed (the selector may be defined in another file); keep plain data only.
    deferSelector: item => {
      const reference = selectorReference(item.path, item.name);
      if (reference) result.deferredSelectors.push({ ...reference, reportNew: item.reportNew });
    }
  };
  const want = name => sections.has(name);
  const effects = [];

  const ast = parseSource(babel, text, file);
  babel.traverse(ast, {
    Program: {
      enter: guard('selectors', path => {
        if (want('selectors')) result.selectorDefs = collectSelectorDefs(path);
      }),
      exit: path => {
        if (want('leaks')) {
          guard('leaks', () => {
            for (let statement of path.get('body')) {
              if ((statement.isExportNamedDeclaration() || statement.isExportDefaultDeclaration()) && statement.node.declaration) {
                statement = statement.get('declaration');
              }
              const candidates = statement.isFunctionDeclaration()
                ? [[statement.node.id?.name, statement]]
                : statement.isVariableDeclaration()
                  ? statement.get('declarations').map(item => [item.node.id.name, item.get('init')])
                  : [];
              for (const [name, fn] of candidates) {
                if (!isEffectWrapper(name ?? '') || !fn?.node || !fn.isFunction()) continue;
                const semantics = wrapperSemantics(fn);
                if (semantics) result.effectWrappers.set(name, semantics);
              }
            }
          })();
          guard('leaks', () => analyzeComponentEffects(effects, leakCtx))();
          guard('leaks', () => checkModuleCaches(path, leakCtx))();
        }
        // A barrel: an index file that re-exports other modules (it may also hold a few helpers of its own).
        result.barrel = /^index\.[cm]?[jt]sx?$/.test(file.split('/').pop()) && path.node.body.some(statement => statement.source && /^Export/.test(statement.type));
      }
    },
    'CallExpression|OptionalCallExpression': path => {
      const callee = unwrap(path.node.callee);
      const name = calleeName(callee);
      if (want('leaks') && name) {
        guard('leaks', () => {
          if (isEffectCall(name) && (callee.type === 'Identifier' || normalized(callee, text).startsWith('React.'))) {
            let fnPath = path.get('arguments.0');
            if (fnPath?.node?.type === 'Identifier') fnPath = functionOf(fnPath); // useMount(subscribe)
            if (isCall(unwrap(fnPath?.node)) && calleeName(unwrap(fnPath.node).callee) === 'useCallback') fnPath = fnPath.get('arguments.0');
            if (fnPath?.node && isFunction(unwrap(fnPath.node)) && fnPath.isFunction()) {
              const owner = ownerPath(path);
              effects.push({
                fnPath,
                deps: path.node.arguments[1] ?? null,
                ownerNode: owner?.path.node ?? null,
                component: owner?.name ?? null,
                unmount: isUnmountHook(name)
              });
              // useMount(() => { …; return cleanup }): judged later, once we know whether useMount runs the cleanup.
              const binding = callee.type === 'Identifier' ? path.scope.getBinding(name) : null;
              if (isEffectWrapper(name) && binding && returnsCleanup(fnPath)) {
                const line = lineOf(path.node);
                result.wrapperCalls.push({
                  hook: name,
                  line,
                  component: owner?.name ?? null,
                  snippet: lines[line - 1],
                  ...(binding.path.isImportSpecifier()
                    ? { source: binding.path.parent.source.value, imported: binding.path.node.imported.name ?? binding.path.node.imported.value }
                    : { local: binding.scope.path.isProgram() ? name : null })
                });
              }
            }
          } else if (name === 'removeEventListener') checkInlineRemove(path, ownerPath(path)?.name ?? null, leakCtx);
        })();
      }
      if (want('selectors') && name) {
        guard('selectors', () => {
          if (callee.type === 'Identifier' && isSelectorHook(name)) analyzeSelectorCall(path, selectorCtx, ownerPath(path)?.name ?? null);
          if (MEMO_FACTORIES.has(name)) checkIdentityMemo(path, selectorCtx, ownerPath(path)?.name ?? null);
          checkCreatedInRender(path, selectorCtx, ownerPath(path));
        })();
      }
      // require('x') at module level is an import; inside a function it runs lazily (like a dynamic import).
      const spec = stringValue(path.node.arguments[0]);
      if (spec && ((callee.type === 'Identifier' && callee.name === 'require' && !path.scope.getBinding('require')) || callee.type === 'Import')) {
        result.imports.push({ spec, line: lineOf(path.node), dynamic: callee.type === 'Import' || Boolean(path.getFunctionParent()), typeOnly: false });
      }
    },
    'ClassDeclaration|ClassExpression': guard('leaks', path => {
      if (!want('leaks') || !path.node.superClass) return;
      if (!COMPONENT_BASE.test(sourceOf(path.node.superClass, text).replace(/\s+/g, ''))) return;
      const name = path.node.id?.name ?? (path.parentPath.isVariableDeclarator() ? path.parentPath.node.id.name : null);
      analyzeClassComponent(path, name, leakCtx);
    }),
    AssignmentExpression: guard('leaks', path => {
      if (!want('leaks') || !path.getFunctionParent()) return;
      const owner = ownerPath(path);
      if (owner) checkGlobalAssignment(path, owner.name, leakCtx);
    }),
    JSXOpeningElement: guard('context', path => {
      if (!want('context')) return;
      const nameNode = path.node.name;
      let provider = null;
      if (nameNode.type === 'JSXMemberExpression' && nameNode.property.name === 'Provider') provider = sourceOf(nameNode, text);
      else if (nameNode.type === 'JSXIdentifier' && /^[A-Z]\w*Context$/.test(nameNode.name)) provider = nameNode.name;
      if (!provider) return;
      const attribute = path.node.attributes.find(item => item.type === 'JSXAttribute' && item.name.name === 'value');
      const value = unwrap(attribute?.value?.expression);
      const valueKind =
        value?.type === 'ObjectExpression' ? 'object' : value?.type === 'ArrayExpression' ? 'array' : isFunction(value) ? 'function' : null;
      if (!valueKind) return;
      const owner = ownerPath(path);
      const line = lineOf(attribute);
      result.contextCandidates.push({ provider, valueKind, line, component: owner?.name ?? null, snippet: lines[line - 1] });
    }),
    ImportDeclaration: path => {
      const node = path.node;
      const spec = node.source.value;
      const typeOnly = node.importKind === 'type' || (node.specifiers.length > 0 && node.specifiers.every(item => item.importKind === 'type'));
      result.imports.push({ spec, line: lineOf(node), dynamic: false, typeOnly });
      if (CSS_MODULE.test(spec)) {
        const usage = { spec, line: lineOf(node), used: new Map(), dynamic: false };
        for (const specifier of node.specifiers) {
          if (specifier.type === 'ImportSpecifier') usage.used.set(specifier.imported.name ?? specifier.imported.value, lineOf(specifier));
          else {
            const binding = path.scope.getBinding(specifier.local.name);
            if (binding) cssModuleUsage(path, binding, usage);
          }
        }
        result.cssModules.push(usage);
      }
    },
    'ExportNamedDeclaration|ExportAllDeclaration': path => {
      const node = path.node;
      if (!node.source) return;
      const typeOnly = node.exportKind === 'type';
      result.imports.push({ spec: node.source.value, line: lineOf(node), dynamic: false, typeOnly });
      result.reexports.push({
        spec: node.source.value,
        names:
          node.type === 'ExportAllDeclaration'
            ? null
            : node.specifiers.map(item => ({ local: item.local?.name ?? 'default', exported: item.exported.name ?? item.exported.value }))
      });
    }
  });
  result.packages = new Set(result.imports.map(item => packageNameOf(item.spec)).filter(Boolean));
  return result;
}
