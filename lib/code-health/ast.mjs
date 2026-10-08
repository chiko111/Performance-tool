// Small AST helpers shared by the JavaScript rules (Babel node shapes, no @babel/types needed).

export const isFunction = node =>
  node && (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression' || node.type === 'FunctionDeclaration');

// Strips TypeScript wrappers that do not change what a value is: `x as Y`, `x!`, `<Y>x`, `(x)`.
export function unwrap(node) {
  while (node && /^(TSAsExpression|TSNonNullExpression|TSTypeAssertion|TSSatisfiesExpression|ParenthesizedExpression)$/.test(node.type)) {
    node = node.expression;
  }
  return node;
}

// 'useEffect' for `useEffect(...)` and `React.useEffect(...)`.
export function calleeName(callee) {
  callee = unwrap(callee);
  if (!callee) return null;
  if (callee.type === 'Identifier') return callee.name;
  if ((callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') && !callee.computed && callee.property.type === 'Identifier') {
    return callee.property.name;
  }
  return null;
}

export const isCall = node => node && (node.type === 'CallExpression' || node.type === 'OptionalCallExpression');
export const isMember = node => node && (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression');

export function sourceOf(node, text) {
  return node && node.start != null ? text.slice(node.start, node.end) : '';
}

// Comparable text of an expression: no whitespace, optional chaining and non-null assertions folded away,
// so `ref.current?.addEventListener` and `ref.current!.removeEventListener` share the target `ref.current`.
export function normalized(node, text) {
  return sourceOf(unwrap(node), text)
    .replace(/\s+/g, '')
    .replace(/\?\./g, '.')
    .replace(/!(?=[.)\]])/g, '')
    .replace(/^\((.*)\)$/, '$1');
}

export const stringValue = node => {
  node = unwrap(node);
  if (!node) return null;
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return null;
};

export const isComponentName = name => Boolean(name) && /^[A-Z]/.test(name);
export const isHookName = name => Boolean(name) && /^use[A-Z0-9]/.test(name);

const WRAPPERS = /^(memo|forwardRef|observer|connect|withRouter|styled)$/;

// The name a function is known by: declaration name, the variable it is assigned to (through memo/forwardRef),
// the class a method belongs to.
export function functionName(path) {
  const node = path.node;
  if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') {
    if (node.id) return node.id.name;
  }
  if (node.type === 'ClassMethod' || node.type === 'ClassPrivateMethod') {
    const classPath = path.findParent(parent => parent.isClassDeclaration() || parent.isClassExpression());
    return classPath?.node.id?.name ?? classNameFromParent(classPath);
  }
  let current = path;
  while (current.parentPath) {
    const parent = current.parentPath;
    if (parent.isVariableDeclarator()) return parent.node.id.type === 'Identifier' ? parent.node.id.name : null;
    if (parent.isClassProperty()) {
      const classPath = parent.findParent(item => item.isClassDeclaration() || item.isClassExpression());
      return classPath?.node.id?.name ?? classNameFromParent(classPath);
    }
    if (parent.isAssignmentExpression()) return parent.node.left.type === 'Identifier' ? parent.node.left.name : null;
    if (parent.isExportDefaultDeclaration()) return null;
    if (parent.isCallExpression() && WRAPPERS.test(calleeName(parent.node.callee) ?? '')) {
      current = parent;
      continue;
    }
    if (parent.isTSAsExpression() || parent.isParenthesizedExpression()) {
      current = parent;
      continue;
    }
    return null;
  }
  return null;
}

function classNameFromParent(classPath) {
  const parent = classPath?.parentPath;
  return parent?.isVariableDeclarator() && parent.node.id.type === 'Identifier' ? parent.node.id.name : null;
}

// Nearest enclosing component or custom hook (callbacks inside it count as the component).
export function ownerPath(path) {
  let current = path.isFunction() || path.isClassMethod() ? path : path.getFunctionParent();
  while (current) {
    const name = functionName(current);
    if (isComponentName(name) || isHookName(name)) return { path: current, name };
    current = current.getFunctionParent();
  }
  return null;
}

// `const [value, setValue] = useState(...)` / `const [state, dispatch] = useReducer(...)`.
export function isStateSetter(path, name) {
  const binding = path.scope.getBinding(name);
  if (!binding || !binding.path.isVariableDeclarator()) return false;
  const { id, init } = binding.path.node;
  if (id.type !== 'ArrayPattern' || id.elements[1]?.type !== 'Identifier' || id.elements[1].name !== name) return false;
  return isCall(unwrap(init)) && /^(useState|useReducer)$/.test(calleeName(unwrap(init).callee) ?? '');
}

export const lineOf = node => node?.loc?.start?.line ?? null;
