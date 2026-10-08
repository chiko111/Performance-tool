// CSS / SCSS rules (web only): CSS-module class names vs. their use in JS, shared sass resources that emit CSS
// into every module, expensive selectors and animations, Sass deprecations, hard-coded colours, z-index sprawl.
// The SCSS scanner is deliberately small: comments and strings stripped, `{`/`}`/`;` structure, `&` resolved.
import fs from 'node:fs';
import path from 'node:path';
import { kb, listText, makeFinding, sortFindings, walkFiles } from './common.mjs';

const STYLE_FILE = /\.(s?css|sass)$/;
const MODULE_FILE = /\.module\.(s?css|sass)$/;
const LAYOUT_PROPS = /^(width|height|min-width|max-width|min-height|max-height|top|left|right|bottom|inset|margin(-\w+)?|padding(-\w+)?|font-size|border(-\w+)?-width)$/;
const SASS_GLOBALS = [
  'darken', 'lighten', 'map-get', 'map-merge', 'map-has-key', 'map-keys', 'map-values', 'map-remove', 'percentage', 'unquote', 'quote',
  'nth', 'length', 'str-index', 'str-slice', 'str-length', 'to-upper-case', 'to-lower-case', 'mix', 'transparentize', 'opacify',
  'fade-in', 'fade-out', 'adjust-hue', 'desaturate', 'complement', 'unitless', 'type-of', 'append', 'comparable'
];
// CSS functions whose arguments may legitimately contain `/` (and are not Sass division).
const CSS_FUNCTIONS = /\b(calc|clamp|min|max|var|env|rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|url|image-set|(repeating-)?(linear|radial|conic)-gradient|format|local|attr|cubic-bezier|steps)\(/g;
const SLASH_PROPS = /^(font|grid-area|grid-row|grid-column|aspect-ratio|border-radius|grid-template(-\w+)?|grid|background|mask|border-image|src)$/;
const COLOR = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b|\b(?:rgba?|hsla?)\(\s*[\d.]+%?\s*[, ][^)]*\)/g;

// ---------- scanner ----------

function lineAt(text, index, cache) {
  // Incremental: scanning is sequential, so count newlines from the last position.
  while (cache.index < index) {
    if (text[cache.index] === '\n') cache.line++;
    cache.index++;
  }
  return cache.line;
}

export function scanScss(text) {
  const root = { type: 'root', children: [], decls: [], statements: [], line: 1, parent: null };
  let block = root;
  let buffer = '';
  let bufferStart = -1;
  let parens = 0;
  const lines = { index: 0, line: 1 };
  const startLine = () => lineAt(text, bufferStart === -1 ? 0 : bufferStart, lines);
  const flushStatement = () => {
    const content = buffer.trim();
    if (content) {
      const line = startLine();
      if (content.startsWith('@')) {
        const match = content.match(/^@([\w-]+)\s*([\s\S]*)$/);
        block.statements.push({ name: match?.[1] ?? '', params: (match?.[2] ?? '').trim(), line });
      } else {
        const match = content.match(/^(--[\w-]+|\$[\w-]+|[\w-]+|\*[\w-]+)\s*:\s*([\s\S]*)$/);
        if (match) block.decls.push({ prop: match[1], value: match[2].trim(), line, important: /!important/.test(match[2]) });
      }
    }
    buffer = '';
    bufferStart = -1;
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '/' && next === '*') {
      const end = text.indexOf('*/', index + 2);
      index = end === -1 ? text.length : end + 1;
      continue;
    }
    if (char === '/' && next === '/' && parens === 0 && text[index - 1] !== ':') {
      const end = text.indexOf('\n', index);
      index = (end === -1 ? text.length : end) - 1;
      continue;
    }
    if (bufferStart === -1 && !/\s/.test(char)) bufferStart = index;
    if (char === '"' || char === "'") {
      let end = index + 1;
      while (end < text.length && text[end] !== char && text[end] !== '\n') end += text[end] === '\\' ? 2 : 1;
      buffer += text.slice(index, end + 1);
      index = end;
      continue;
    }
    if (char === '#' && next === '{') {
      let depth = 0;
      let end = index + 1;
      for (; end < text.length; end++) {
        if (text[end] === '{') depth++;
        else if (text[end] === '}' && --depth === 0) break;
      }
      buffer += text.slice(index, end + 1);
      index = end;
      continue;
    }
    if (char === '(') parens++;
    else if (char === ')') parens = Math.max(0, parens - 1);
    if (parens === 0 && char === '{') {
      const prelude = buffer.trim();
      const type = prelude.startsWith('@') ? 'at' : 'rule';
      const child = { type, prelude, line: startLine(), children: [], decls: [], statements: [], parent: block };
      if (child.type === 'at') {
        const match = prelude.match(/^@([\w-]+)\s*([\s\S]*)$/);
        child.name = match?.[1] ?? '';
        child.params = (match?.[2] ?? '').trim();
      } else if (/^[\w-]+\s*:$/.test(prelude)) child.type = 'nested-property';
      block.children.push(child);
      block = child;
      buffer = '';
      bufferStart = -1;
    } else if (parens === 0 && char === ';') flushStatement();
    else if (parens === 0 && char === '}') {
      flushStatement();
      block = block.parent ?? root;
    } else buffer += char;
  }
  flushStatement();
  return root;
}

// Commas outside parentheses separate selectors.
function splitSelectors(text) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function resolveSelectors(parents, prelude) {
  const own = splitSelectors(prelude.replace(/\s+/g, ' '));
  if (!parents) return own;
  const resolved = [];
  for (const parent of parents) {
    for (const selector of own) resolved.push(selector.includes('&') ? selector.replace(/&/g, parent) : `${parent} ${selector}`);
  }
  return resolved;
}

// Walks the tree with context: resolved selectors, mixin/function bodies, keyframes, loops, :global, depth.
const ROOT_CONTEXT = { selectors: null, inMixin: false, inKeyframes: null, dynamic: false, global: false, depth: 0, atChain: '' };

function walk(node, visit, context = ROOT_CONTEXT) {
  for (const child of node.children) {
    let next = context;
    if (child.type === 'at') {
      const name = child.name;
      next = {
        ...context,
        inMixin: context.inMixin || name === 'mixin' || name === 'function',
        inKeyframes: /keyframes$/.test(name) ? child.params : context.inKeyframes,
        dynamic: context.dynamic || /^(each|for|while)$/.test(name),
        selectors: name === 'at-root' ? (child.params ? resolveSelectors(null, child.params) : null) : context.selectors,
        // Rules under different @media / @include breakpoint mixins / @if branches are different contexts.
        atChain: name === 'at-root' ? context.atChain : `${context.atChain}@${name} ${child.params};`
      };
    } else if (child.type === 'rule' && !context.inKeyframes) {
      const prelude = child.prelude;
      const globalBlock = /^:global\s*$/.test(prelude); // `:global { … }`: everything inside is global
      next = {
        ...context,
        selectors: globalBlock ? context.selectors : resolveSelectors(context.selectors, prelude),
        global: context.global || globalBlock,
        depth: context.depth + 1
      };
    }
    visit(child, next, context);
    walk(child, visit, next);
  }
}

// Class names a resolved selector defines locally (`:global(...)` and `:global .x` parts excluded).
function classesOf(selector) {
  const local = selector.replace(/:global\([^)]*\)/g, ' ').replace(/:global\s.*$/, ' ').replace(/\[[^\]]*\]/g, ' ');
  return [...local.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map(match => match[1]);
}

const camelCase = name => name.replace(/-+(\w)/g, (_, char) => char.toUpperCase());

// ---------- sass import resolution ----------

function sassCandidates(base) {
  const dir = path.dirname(base);
  const name = path.basename(base);
  if (/\.(s?css|sass)$/.test(name)) return [base, path.join(dir, `_${name}`)];
  return [
    ...['.scss', '.sass', '.css'].flatMap(ext => [path.join(dir, `${name}${ext}`), path.join(dir, `_${name}${ext}`)]),
    ...['_index.scss', 'index.scss', '_index.sass', 'index.sass'].map(index => path.join(base, index))
  ];
}

function resolveSass(fromFile, spec, ctx) {
  if (/^(sass:|https?:|url\()/.test(spec)) return null;
  const tryBase = base => sassCandidates(base).find(file => fs.existsSync(file) && fs.statSync(file).isFile()) ?? null;
  if (spec.startsWith('~')) return tryBase(path.join(ctx.repoRoot, 'node_modules', spec.slice(1)));
  const relative = tryBase(path.resolve(path.dirname(fromFile), spec));
  if (relative) return relative;
  for (const alias of ctx.resolver.aliases) {
    const star = alias.pattern.indexOf('*');
    const prefix = star === -1 ? alias.pattern : alias.pattern.slice(0, star);
    if (star === -1 ? spec !== prefix && !spec.startsWith(`${prefix}/`) : !spec.startsWith(prefix)) continue;
    const rest = star === -1 ? spec.slice(prefix.length).replace(/^\//, '') : spec.slice(prefix.length);
    for (const target of alias.targets) {
      const found = tryBase(star === -1 ? path.join(target, rest) : target.replace('*', rest));
      if (found) return found;
    }
  }
  return tryBase(path.join(ctx.repoRoot, 'node_modules', spec));
}

function importsOf(tree) {
  const found = [];
  const collect = node => {
    for (const statement of node.statements) {
      if (/^(import|use|forward)$/.test(statement.name)) {
        for (const match of statement.params.matchAll(/(['"])([^'"]+)\1/g)) found.push({ kind: statement.name, spec: match[2], line: statement.line });
      }
    }
    for (const child of node.children) collect(child);
  };
  collect(tree);
  return found;
}

// sass-resources-loader `resources` and sass-loader `additionalData`/`prependData` from webpack.config.*.
function sharedResources(ctx) {
  const files = [];
  for (const name of ['webpack.config.js', 'webpack.config.cjs', 'webpack.config.mjs', 'webpack.config.ts']) {
    const configFile = path.join(ctx.repoRoot, name);
    if (!fs.existsSync(configFile)) continue;
    const text = fs.readFileSync(configFile, 'utf8');
    for (const block of text.matchAll(/resources\s*:\s*(\[[\s\S]*?\]|[^,}\n]+)/g)) {
      for (const match of block[1].matchAll(/(['"])([^'"]+\.s[ac]ss)\1/g)) files.push(path.resolve(ctx.repoRoot, match[2]));
    }
    for (const block of text.matchAll(/(?:additionalData|prependData)\s*:\s*(['"`])([\s\S]*?)\1/g)) {
      for (const match of block[2].matchAll(/@(?:import|use)\s+['"]([^'"]+)['"]/g)) {
        const found = resolveSass(path.join(ctx.repoRoot, 'src/index.scss'), match[1], ctx);
        if (found) files.push(found);
      }
    }
  }
  return [...new Set(files)].filter(file => fs.existsSync(file));
}

// ---------- analysis ----------

export function runCss(ctx) {
  const rel = file => {
    const root = ctx.roots.find(item => file.startsWith(item.dir + path.sep));
    return root ? path.join(root.prefix, path.relative(root.dir, file)) : path.relative(ctx.repoRoot, file);
  };
  const styleFiles = ctx.roots.flatMap(root => walkFiles(root.dir, name => STYLE_FILE.test(name)));
  const trees = new Map();
  const treeOf = file => {
    if (!trees.has(file)) {
      try {
        const text = fs.readFileSync(file, 'utf8');
        trees.set(file, { text, tree: scanScss(text) });
      } catch (error) {
        ctx.errors.push({ section: 'css', file: rel(file), message: `could not scan: ${error.message}` });
        trees.set(file, null);
      }
    }
    return trees.get(file);
  };
  const findings = [];
  const add = finding => findings.push(makeFinding(finding));

  // Shared resources and everything they pull in.
  const resourceRoots = sharedResources(ctx);
  const resources = new Set();
  const queue = [...resourceRoots];
  while (queue.length) {
    const file = queue.shift();
    if (resources.has(file)) continue;
    resources.add(file);
    const scanned = treeOf(file);
    for (const item of scanned ? importsOf(scanned.tree) : []) {
      const target = resolveSass(file, item.spec, ctx);
      if (target && !resources.has(target)) queue.push(target);
    }
  }

  // Variables (for z-index values) and mixins that define classes (for "maybe defined" module classes).
  const variables = new Map();
  const classMixins = new Set();
  const userFunctions = new Set();
  for (const file of new Set([...resources, ...styleFiles])) {
    const scanned = treeOf(file);
    if (!scanned) continue;
    for (const decl of scanned.tree.decls) {
      if (decl.prop.startsWith('$') && !variables.has(decl.prop)) variables.set(decl.prop, decl.value.replace(/!default/, '').trim());
    }
    walk(scanned.tree, child => {
      if (child.type === 'at' && child.name === 'function') userFunctions.add(child.params.split('(')[0].trim());
      if (child.type === 'at' && child.name === 'mixin') {
        const name = child.params.split('(')[0].trim();
        let defines = false;
        walk(child, inner => {
          if (inner.type === 'rule' && (/\.[_a-zA-Z-]/.test(inner.prelude) || /&[-_a-zA-Z]/.test(inner.prelude))) defines = true;
        });
        if (defines) classMixins.add(name);
      }
    });
  }

  const moduleFiles = styleFiles.filter(file => MODULE_FILE.test(file));
  const definitions = new Map(); // module file -> { own: Map(name -> line), all: Set, uncertain: boolean }
  const definedIn = (file, seen = new Set()) => {
    const result = { own: new Map(), all: new Set(), uncertain: false };
    const scanned = treeOf(file);
    if (!scanned || seen.has(file)) return result;
    seen.add(file);
    walk(scanned.tree, (child, context) => {
      if (child.type === 'at' && child.name === 'include' && classMixins.has(child.params.split(/[\s(;]/)[0])) result.uncertain = true;
      if (child.type !== 'rule' || context.inKeyframes || context.global) return;
      if (child.prelude.includes('#{') || context.dynamic) result.uncertain = true;
      if (context.inMixin) return;
      for (const selector of context.selectors ?? []) {
        for (const name of classesOf(selector)) {
          if (!result.own.has(name)) result.own.set(name, child.line);
          result.all.add(name);
        }
      }
    });
    for (const statement of scanned.tree.statements) {
      if (statement.name === 'include' && classMixins.has(statement.params.split(/[\s(;]/)[0])) result.uncertain = true;
    }
    // Partials imported into the module emit their classes into it too.
    for (const item of importsOf(scanned.tree)) {
      const target = resolveSass(file, item.spec, ctx);
      if (!target || resources.has(target)) continue;
      const nested = definedIn(target, seen);
      for (const name of nested.all) result.all.add(name);
      result.uncertain ||= nested.uncertain;
    }
    return result;
  };
  const resourceClasses = new Set();
  for (const file of resources) for (const name of definedIn(file).all) resourceClasses.add(name);
  for (const file of moduleFiles) {
    const result = definedIn(file);
    for (const name of resourceClasses) result.all.add(name);
    definitions.set(file, result);
  }

  // Usage from JS/TS.
  const usage = new Map(); // module file -> { names: Set, dynamic: boolean, importers: [] }
  for (const [jsFile, result] of ctx.js ?? []) {
    for (const item of result.cssModules) {
      const target = ctx.resolver.resolve(jsFile, item.spec);
      if (!target || !definitions.has(target)) continue;
      const entry = usage.get(target) ?? { names: new Set(), dynamic: false, importers: [] };
      entry.dynamic ||= item.dynamic;
      entry.importers.push(result.relative);
      for (const name of item.used.keys()) entry.names.add(name);
      usage.set(target, entry);
      const defined = definitions.get(target);
      if (defined.uncertain) continue;
      const missing = [...item.used].filter(
        ([name]) => !defined.all.has(name) && ![...defined.all].some(cls => camelCase(cls) === name) && !/^(default|toString|hasOwnProperty)$/.test(name)
      );
      if (!missing.length) continue;
      // One finding per importing file and module, listing every missing name.
      const [, line] = missing[0];
      add({
        rule: 'css-module-missing-class',
        severity: 'high',
        file: result.relative,
        line,
        key: rel(target),
        snippet: fs.readFileSync(jsFile, 'utf8').split('\n')[line - 1] ?? null,
        message: `${item.spec} has no class${missing.length === 1 ? '' : 'es'} ${listText(missing.map(([name, at]) => `"${name}" (line ${at})`), 8)}, so ${missing.length === 1 ? 'that className becomes' : 'those classNames become'} undefined and the elements get no style from ${missing.length === 1 ? 'it' : 'them'}.`,
        fix: `Add the class${missing.length === 1 ? '' : 'es'} to ${path.basename(target)} or remove/fix the reference${missing.length === 1 ? '' : 's'}.`
      });
    }
  }
  // composes: x y from './other.module.scss' counts as use of x and y in that module.
  for (const file of moduleFiles) {
    const scanned = treeOf(file);
    for (const match of scanned?.text.matchAll(/composes\s*:\s*([^;]+?)\s+from\s+(['"])([^'"]+)\2/g) ?? []) {
      const target = resolveSass(file, match[3], ctx);
      const entry = target && usage.get(target);
      if (entry) for (const name of match[1].split(/\s+/)) entry.names.add(name);
    }
    for (const match of scanned?.text.matchAll(/composes\s*:\s*([^;]+?)\s*;/g) ?? []) {
      if (/\sfrom\s/.test(match[1])) continue;
      const entry = usage.get(file);
      if (entry) for (const name of match[1].split(/\s+/)) entry.names.add(name);
    }
  }
  for (const [file, defined] of definitions) {
    const used = usage.get(file);
    if (!used || used.dynamic) continue; // never imported from JS, or used through a computed key / passed on
    const unused = [...defined.own.keys()].filter(name => !used.names.has(name) && !used.names.has(camelCase(name)));
    if (!unused.length) continue;
    add({
      rule: 'css-module-unused-class',
      severity: 'low',
      file: rel(file),
      line: defined.own.get(unused[0]),
      key: 'unused',
      message: `${unused.length} class${unused.length === 1 ? ' is' : 'es are'} never used by the ${used.importers.length === 1 ? 'file' : `${used.importers.length} files`} importing this module: ${listText(unused, 10)}; dead CSS still ships and is parsed on every load.`,
      fix: 'Delete the unused rules (check for class names built at runtime first).'
    });
  }

  // Shared resources must not emit CSS: it is copied into every CSS module.
  const emitted = [];
  for (const file of resources) {
    const scanned = treeOf(file);
    if (!scanned) continue;
    for (const decl of scanned.tree.decls) {
      if (!decl.prop.startsWith('$')) emitted.push({ file, line: decl.line, what: `top-level ${decl.prop}`, bytes: decl.prop.length + decl.value.length + 2 });
    }
    walk(scanned.tree, (child, context) => {
      if (context.inMixin || child.type === 'nested-property') return;
      if (child.type === 'at' && (/keyframes$/.test(child.name) || child.name === 'font-face')) {
        emitted.push({ file, line: child.line, what: `@${child.name} ${child.params}`.trim(), bytes: blockBytes(child) });
      } else if (child.type === 'rule' && !context.inKeyframes && child.decls.some(decl => !decl.prop.startsWith('$'))) {
        const selectors = context.selectors ?? [];
        if (selectors.every(selector => selector.includes('%')) || /^:export\b/.test(child.prelude)) return;
        emitted.push({ file, line: child.line, what: selectors.join(', ').slice(0, 80), bytes: blockBytes(child) });
      }
    });
  }
  if (emitted.length) {
    const bytes = emitted.reduce((sum, item) => sum + item.bytes, 0);
    const first = emitted[0];
    add({
      rule: 'shared-resource-emits-css',
      severity: 'high',
      file: rel(first.file),
      line: first.line,
      key: 'shared',
      message: `Shared sass resources emit real CSS (${listText(emitted.map(item => `${item.what} in ${path.basename(item.file)}:${item.line}`), 5)}), which sass-resources-loader copies into each of the ${moduleFiles.length} CSS modules: about ${kb(bytes)} kB × ${moduleFiles.length} ≈ ${kb(bytes * moduleFiles.length)} kB of duplicated CSS.`,
      fix: 'Keep only variables, mixins, functions and %placeholders in shared resources; move real rules into a global stylesheet imported once.'
    });
  }

  // Per-file style rules.
  let rules = 0;
  let importantCount = 0;
  let colorLiterals = 0;
  const willChange = new Map();
  const zIndexes = new Map(); // value -> Set(files)
  for (const file of styleFiles) {
    const scanned = treeOf(file);
    if (!scanned) continue;
    const label = rel(file);
    const isResource = resources.has(file);
    const stats = {
      maxDepth: 0,
      depthLine: null,
      universal: [],
      has: [],
      transitions: [],
      important: 0,
      imports: [],
      globals: new Map(),
      slashes: [],
      colors: new Map(),
      colorLine: null,
      selectors: new Map()
    };
    const fileUses = /@use\s+['"]sass:/.test(scanned.text);
    const checkValue = (decl, context) => {
      const value = decl.value;
      if (decl.important) stats.important++;
      if (!context.inMixin && !decl.prop.startsWith('$') && /^(transition|transition-property)$/.test(decl.prop)) {
        const words = value.split(/[\s,]+/);
        const layout = words.filter(word => LAYOUT_PROPS.test(word));
        if (words.includes('all') || layout.length) stats.transitions.push({ line: decl.line, what: words.includes('all') ? 'all' : layout.join(', ') });
      }
      if (decl.prop === 'will-change' && !context.inMixin) willChange.set(label, (willChange.get(label) ?? 0) + 1);
      if (decl.prop === 'z-index') {
        const resolved = /^\$[\w-]+$/.test(value) ? variables.get(value) ?? value : value;
        const number = Number(resolved.replace(/!important/, '').trim());
        if (Number.isFinite(number)) {
          if (!zIndexes.has(number)) zIndexes.set(number, new Set());
          zIndexes.get(number).add(label);
        }
      }
      for (const name of SASS_GLOBALS) {
        if (userFunctions.has(name)) continue;
        const pattern = new RegExp(`(?<![\\w.$-])${name}\\(`, 'g');
        const count = (value.match(pattern) ?? []).length;
        if (count) stats.globals.set(name, (stats.globals.get(name) ?? 0) + count);
      }
      if (!SLASH_PROPS.test(decl.prop) && value.includes('/')) {
        const stripped = stripCssFunctions(value);
        if (/\$[\w-]+\s*\/\s*[\w$(.]|[\w.)]\s*\/\s*\$[\w-]+|\(\s*-?[\d.]+[a-z%]*\s*\/\s*-?[\d.]+[a-z%]*\s*\)/.test(stripped)) stats.slashes.push(decl.line);
      }
      const colors = value.replace(/url\([^)]*\)/g, '').match(COLOR) ?? [];
      for (const color of colors) {
        const key = color.replace(/\s+/g, '').toLowerCase();
        stats.colors.set(key, (stats.colors.get(key) ?? 0) + 1);
        stats.colorLine ??= decl.line;
      }
    };
    for (const decl of scanned.tree.decls) checkValue(decl, { inMixin: false });
    const countImports = node => {
      for (const statement of node.statements) {
        if (statement.name === 'import' && !/^url\(|\.css['"]|['"]https?:/.test(statement.params)) stats.imports.push(statement.line);
      }
    };
    countImports(scanned.tree);
    walk(scanned.tree, (child, context) => {
      countImports(child);
      for (const decl of child.decls) checkValue(decl, context);
      if (child.type === 'at' && /keyframes$/.test(child.name) && !context.inMixin) {
        const props = new Set();
        walk(child, inner => inner.decls.forEach(decl => LAYOUT_PROPS.test(decl.prop) && props.add(decl.prop)));
        for (const decl of child.decls) if (LAYOUT_PROPS.test(decl.prop)) props.add(decl.prop);
        if (props.size) {
          add({
            rule: 'animates-layout',
            severity: 'high',
            file: label,
            line: child.line,
            key: child.params,
            snippet: scanned.text.split('\n')[child.line - 1],
            message: `@keyframes ${child.params} animates ${[...props].join(', ')}, which forces layout (and paint) on every frame of the animation.`,
            fix: 'Animate transform (translate/scale) and opacity instead; they run on the compositor.'
          });
        }
      }
      if (child.type !== 'rule' || context.inKeyframes) return;
      const selectors = (context.selectors ?? []).filter(Boolean);
      if (child.decls.some(decl => !decl.prop.startsWith('$'))) rules++;
      const depth = context.depth;
      if (depth > stats.maxDepth) {
        stats.maxDepth = depth;
        stats.depthLine = child.line;
      }
      if (/:has\(/.test(child.prelude)) stats.has.push(child.line);
      if (!context.inMixin && isExpensiveUniversal(selectors, context)) stats.universal.push(child.line);
      if (!context.inMixin && !context.dynamic && child.decls.length) {
        const key = `${context.atChain}|${selectors.join(',')}`;
        const seen = stats.selectors.get(key);
        if (seen) seen.count++;
        else stats.selectors.set(key, { count: 1, line: child.line, text: selectors.join(', ') });
      }
    });
    importantCount += stats.important;
    const snippet = line => scanned.text.split('\n')[line - 1] ?? null;
    if (stats.maxDepth > 4) {
      add({
        rule: 'deep-nesting',
        severity: 'low',
        file: label,
        line: stats.depthLine,
        key: 'depth',
        snippet: snippet(stats.depthLine),
        message: `Selectors are nested ${stats.maxDepth} levels deep, producing long, high-specificity selectors that are slow to match and hard to override.`,
        fix: 'Flatten to at most 3-4 levels: give deep elements their own class.'
      });
    }
    if (stats.universal.length) {
      add({
        rule: 'universal-selector',
        severity: 'medium',
        file: label,
        line: stats.universal[0],
        key: 'universal',
        snippet: snippet(stats.universal[0]),
        message: `${stats.universal.length} selector${stats.universal.length === 1 ? ' ends' : 's end'} in a descendant \`*\`, which the browser has to test against every element below the parent on each style recalculation.`,
        fix: 'Target a class (or a direct child `> *` if that is what is meant).'
      });
    }
    if (stats.has.length) {
      add({
        rule: 'has-selector',
        severity: 'low',
        file: label,
        line: stats.has[0],
        key: 'has',
        snippet: snippet(stats.has[0]),
        message: `${stats.has.length} :has() selector${stats.has.length === 1 ? '' : 's'}: every DOM change below the subject can trigger a style recalculation, and older browsers ignore the rule.`,
        fix: 'Prefer a class toggled from JS when the condition changes often.'
      });
    }
    if (stats.transitions.length) {
      add({
        rule: 'transition-layout-property',
        severity: 'medium',
        file: label,
        line: stats.transitions[0].line,
        key: 'transition',
        snippet: snippet(stats.transitions[0].line),
        message: `${stats.transitions.length} transition${stats.transitions.length === 1 ? '' : 's'} on ${listText([...new Set(stats.transitions.map(item => item.what))], 4)}: animating layout properties (or \`all\`) relayouts the page on every frame.`,
        fix: 'Transition transform/opacity (e.g. scaleY or translate instead of height/top), and list the properties instead of `all`.'
      });
    }
    if (stats.important > 10) {
      add({
        rule: 'important-overuse',
        severity: 'low',
        file: label,
        line: null,
        key: 'important',
        message: `${stats.important} !important declarations: specificity wars make styles hard to override and debug.`,
        fix: 'Lower the specificity of the rules being overridden instead of adding !important.'
      });
    }
    if (stats.imports.length) {
      add({
        rule: 'sass-import-deprecated',
        severity: 'low',
        file: label,
        line: stats.imports[0],
        key: 'import',
        snippet: snippet(stats.imports[0]),
        message: `${stats.imports.length} Sass @import${stats.imports.length === 1 ? '' : 's'}: @import is deprecated and removed in Dart Sass 3, and it re-evaluates the imported file each time.`,
        fix: 'Switch to @use (with a namespace) / @forward.'
      });
    }
    if (stats.globals.size) {
      const total = [...stats.globals.values()].reduce((sum, count) => sum + count, 0);
      add({
        rule: 'sass-global-function',
        severity: 'low',
        file: label,
        line: null,
        key: 'globals',
        message: `${total} call${total === 1 ? '' : 's'} to global Sass functions (${listText([...stats.globals.keys()], 5)})${fileUses ? '' : ' without @use "sass:…"'}: global built-ins are deprecated and removed in Dart Sass 3.`,
        fix: 'Use the module functions (@use "sass:color" → color.adjust/color.scale, "sass:map" → map.get, "sass:math" → math.percentage).'
      });
    }
    if (stats.slashes.length) {
      add({
        rule: 'sass-slash-division',
        severity: 'low',
        file: label,
        line: stats.slashes[0],
        key: 'slash',
        snippet: snippet(stats.slashes[0]),
        message: `${stats.slashes.length} division${stats.slashes.length === 1 ? '' : 's'} with \`/\`: slash division is deprecated and becomes a plain separator in Dart Sass 3.`,
        fix: 'Use math.div(a, b) (@use "sass:math") or calc().'
      });
    }
    const colorCount = [...stats.colors.values()].reduce((sum, count) => sum + count, 0);
    const palette = isResource || isPaletteFile(scanned.text);
    if (!palette) colorLiterals += colorCount;
    if (!palette && colorCount >= 3) {
      const top = [...stats.colors].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([color, count]) => `${color} ×${count}`);
      add({
        rule: 'hardcoded-color',
        severity: 'low',
        file: label,
        line: stats.colorLine,
        key: 'colors',
        message: `${colorCount} hard-coded colour literals (${top.join(', ')}) bypass the palette, so theme/brand changes miss them.`,
        fix: 'Use the palette variables / CSS custom properties.'
      });
    }
    const duplicates = [...stats.selectors.values()].filter(item => item.count > 1 && item.text);
    if (duplicates.length) {
      add({
        rule: 'duplicate-selector',
        severity: 'low',
        file: label,
        line: duplicates[0].line,
        key: 'duplicates',
        snippet: snippet(duplicates[0].line),
        message: `${duplicates.length} selector${duplicates.length === 1 ? ' is' : 's are'} declared in more than one block in the same context (${listText(duplicates.map(item => item.text.slice(0, 50)), 5)}), so later blocks silently override earlier ones.`,
        fix: 'Merge the blocks.'
      });
    }
  }
  const willChangeTotal = [...willChange.values()].reduce((sum, count) => sum + count, 0);
  if (willChangeTotal > 10) {
    const [file] = [...willChange].sort((a, b) => b[1] - a[1])[0];
    add({
      rule: 'will-change-overuse',
      severity: 'low',
      file,
      line: null,
      key: 'will-change',
      message: `will-change is used ${willChangeTotal} times in ${willChange.size} files: every will-change element gets its own compositor layer and GPU memory, even when nothing animates.`,
      fix: 'Set will-change only on elements that are about to animate (or drop it; browsers promote layers for active animations).'
    });
  }
  const zValues = [...zIndexes.keys()].sort((a, b) => b - a);
  if (zValues.length > 15 || zValues[0] >= 1000) {
    const top = zValues[0];
    add({
      rule: 'z-index-chaos',
      severity: 'low',
      file: [...zIndexes.get(top)][0],
      line: null,
      key: 'z-index',
      message: `${zValues.length} distinct z-index values (highest ${top} in ${listText([...zIndexes.get(top)], 3)}; values: ${listText(zValues.map(String), 20)}): without a scale, layers end up competing with ever larger numbers.`,
      fix: 'Define a small z-index scale (variables) and use only those values.'
    });
  }

  const cssKbByChunk = [];
  for (const chunk of ctx.stats?.chunks ?? []) {
    const bytes = (chunk.files ?? []).filter(item => /\.css$/.test(item.file)).reduce((sum, item) => sum + (item.bytes ?? 0), 0);
    if (bytes) cssKbByChunk.push({ chunk: chunk.name ?? '(unnamed)', kb: kb(bytes), initial: Boolean(chunk.initial) });
  }
  return {
    findings: sortFindings(findings),
    stats: {
      files: styleFiles.length,
      modules: moduleFiles.length,
      rules,
      importantCount,
      colorLiterals,
      cssKbByChunk: cssKbByChunk.sort((a, b) => Number(b.initial) - Number(a.initial) || b.kb - a.kb)
    }
  };
}

function blockBytes(block) {
  let bytes = block.prelude.length + 2;
  for (const decl of block.decls) bytes += decl.prop.length + decl.value.length + 2;
  for (const child of block.children) bytes += blockBytes(child);
  return bytes;
}

// Removes the arguments of CSS functions (calc(), rgb(), var() …) where `/` is legitimate.
function stripCssFunctions(value) {
  let out = value;
  for (let guard = 0; guard < 10; guard++) {
    const next = out.replace(CSS_FUNCTIONS, '\u0000(').replace(/\u0000\([^()]*\)/g, 'fn');
    if (next === out) break;
    out = next;
  }
  return out.replace(/\u0000\(/g, '(');
}

// `.list *`, `.a .b *` (descendant universal as the key selector); the `*, *::before, *::after` reset is fine.
function isExpensiveUniversal(selectors, context) {
  return selectors.some(selector => {
    const compounds = selector.split(/\s*[>+~]\s*|\s+/).filter(Boolean);
    const last = compounds[compounds.length - 1] ?? '';
    if (!/^\*(::?[\w-]+)*$/.test(last)) return false;
    if (compounds.length === 1) return context.depth > 0; // nested bare `*`
    return new RegExp(`\\s\\*(::?[\\w-]+)*$`).test(selector) && !/[>+~]\s*\*(::?[\w-]+)*$/.test(selector);
  });
}

// A palette file mostly defines variables with colours.
function isPaletteFile(text) {
  const lines = text.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('//') && !line.startsWith('/*') && !line.startsWith('*'));
  if (!lines.length) return false;
  const definitions = lines.filter(line => /^(\$|--)[\w-]+\s*:/.test(line)).length;
  return definitions / lines.length >= 0.6;
}
