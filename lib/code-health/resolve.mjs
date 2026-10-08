// Resolves import specifiers of the project's own files the way its bundler would: relative paths, index files,
// tsconfig/jsconfig `paths`, webpack `resolve.alias` and babel-plugin-module-resolver aliases.
import fs from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { readJsonc } from './common.mjs';

const BUILTINS = new Set(builtinModules);
const SCRIPT_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
// Metro picks platform files first; for the import graph one platform is enough (iOS, like the probe builds).
const NATIVE_EXTENSIONS = SCRIPT_EXTENSIONS.flatMap(ext => [`.ios${ext}`, `.native${ext}`]).concat(SCRIPT_EXTENSIONS);

// Package name of a bare specifier ('@scope/name/deep/path' -> '@scope/name'), null for paths and Node built-ins.
export function packageNameOf(specifier) {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) return null;
  if (/^[a-z]+:/i.test(specifier)) return null; // data:, http:, virtual: …
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  return BUILTINS.has(name) ? null : name;
}

function tsconfigAliases(repoRoot) {
  const aliases = [];
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const file = path.join(repoRoot, name);
    if (!fs.existsSync(file)) continue;
    let options;
    try {
      options = readJsonc(file).compilerOptions ?? {};
    } catch {
      continue;
    }
    const base = path.resolve(repoRoot, options.baseUrl ?? '.');
    for (const [pattern, targets] of Object.entries(options.paths ?? {})) {
      aliases.push({ pattern, targets: targets.map(target => path.resolve(base, target)), source: name });
    }
    if (options.baseUrl) aliases.push({ pattern: '*', targets: [path.join(base, '*')], source: name, fallback: true });
  }
  return aliases;
}

// Only the literal `'key': path.resolve(__dirname, 'dir')` shapes; computed paths (template strings) are skipped.
function webpackAliases(repoRoot) {
  const aliases = [];
  for (const name of ['webpack.config.js', 'webpack.config.cjs', 'webpack.config.mjs', 'webpack.config.ts']) {
    const file = path.join(repoRoot, name);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const block = text.match(/alias\s*:\s*\{([\s\S]*?)\n\s*\}/);
    if (!block) continue;
    const entry = /['"]?([@\w$\-/.]+?)['"]?\s*:\s*path\.(?:resolve|join)\(\s*__dirname\s*,\s*(['"])([^'"]+)\2\s*\)/g;
    for (const match of block[1].matchAll(entry)) {
      const exact = match[1].endsWith('$');
      const key = match[1].replace(/\$$/, '');
      const target = path.resolve(repoRoot, match[3]);
      aliases.push({ pattern: key, targets: [target], source: name, exact });
      if (!exact) aliases.push({ pattern: `${key}/*`, targets: [path.join(target, '*')], source: name });
    }
  }
  return aliases;
}

function babelAliases(repoRoot) {
  const aliases = [];
  const roots = [];
  for (const name of ['babel.config.js', 'babel.config.cjs', '.babelrc', '.babelrc.js', '.babelrc.json']) {
    const file = path.join(repoRoot, name);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (!/module-resolver/.test(text)) continue;
    const block = text.match(/alias\s*:\s*\{([^}]*)\}/);
    for (const match of block?.[1].matchAll(/['"]?([@\w$\-/.]+?)['"]?\s*:\s*(['"])([^'"]+)\2/g) ?? []) {
      const target = path.resolve(repoRoot, match[3]);
      aliases.push({ pattern: match[1], targets: [target], source: name });
      aliases.push({ pattern: `${match[1]}/*`, targets: [path.join(target, '*')], source: name });
    }
    const rootList = text.match(/root\s*:\s*\[([^\]]*)\]/);
    for (const match of rootList?.[1].matchAll(/(['"])([^'"]+)\1/g) ?? []) roots.push(path.resolve(repoRoot, match[2]));
  }
  return { aliases, roots };
}

// Most specific pattern first: exact keys, then the longest prefix before '*'.
function specificity(alias) {
  const star = alias.pattern.indexOf('*');
  return star === -1 ? 10000 + alias.pattern.length : star;
}

export function createResolver(repoRoot, { kind, sourceDirs }) {
  const babel = babelAliases(repoRoot);
  const aliases = [...tsconfigAliases(repoRoot), ...webpackAliases(repoRoot), ...babel.aliases]
    .sort((a, b) => specificity(b) - specificity(a) || Number(Boolean(a.fallback)) - Number(Boolean(b.fallback)));
  const extensions = kind === 'react-native' ? NATIVE_EXTENSIONS : SCRIPT_EXTENSIONS;
  const statCache = new Map();
  const statOf = file => {
    if (!statCache.has(file)) {
      let kindOf = null;
      try {
        const stat = fs.statSync(file);
        kindOf = stat.isDirectory() ? 'dir' : 'file';
      } catch {}
      statCache.set(file, kindOf);
    }
    return statCache.get(file);
  };

  function probe(base) {
    if (statOf(base) === 'file') return base;
    for (const ext of extensions) if (statOf(base + ext) === 'file') return base + ext;
    if (statOf(base) === 'dir') {
      for (const ext of extensions) if (statOf(path.join(base, `index${ext}`)) === 'file') return path.join(base, `index${ext}`);
    }
    return null;
  }

  function viaAliases(specifier) {
    for (const alias of aliases) {
      const star = alias.pattern.indexOf('*');
      let rest = null;
      if (star === -1) {
        if (specifier === alias.pattern) rest = '';
      } else {
        const prefix = alias.pattern.slice(0, star);
        const suffix = alias.pattern.slice(star + 1);
        if (specifier.startsWith(prefix) && specifier.endsWith(suffix) && specifier.length >= prefix.length + suffix.length) {
          rest = specifier.slice(prefix.length, specifier.length - suffix.length);
        }
      }
      if (rest == null) continue;
      for (const target of alias.targets) {
        const found = probe(target.replace('*', rest));
        if (found) return found;
      }
    }
    return null;
  }

  // Absolute path of an own file, or null for packages and anything that does not exist.
  function resolve(fromFile, specifier) {
    if (!specifier || /^[a-z]+:/i.test(specifier)) return null;
    const clean = specifier.replace(/[?#].*$/, '').replace(/^~(?!\/)/, '');
    if (clean.startsWith('.') || clean.startsWith('/')) return probe(path.resolve(path.dirname(fromFile), clean));
    const aliased = viaAliases(clean);
    if (aliased) return aliased;
    for (const root of babel.roots) {
      const found = probe(path.join(root, clean));
      if (found) return found;
    }
    // A package whose source folder is configured as a source dir (e.g. node_modules/@org/core/src).
    const inModules = sourceDirs.some(dir => dir.includes(`${path.sep}node_modules${path.sep}`))
      ? probe(path.join(repoRoot, 'node_modules', clean))
      : null;
    return inModules && sourceDirs.some(dir => inModules.startsWith(dir + path.sep)) ? inModules : null;
  }

  return { resolve, aliases, probe };
}
