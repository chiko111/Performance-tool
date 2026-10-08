// Helpers shared by the code-health analysers: findings, source lines, Babel loading, JSON with comments.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

export const SEVERITIES = ['high', 'medium', 'low'];
export const severityRank = severity => SEVERITIES.indexOf(severity);

const sha1 = text => crypto.createHash('sha1').update(text).digest('hex');

// The id must survive unrelated edits elsewhere in the file, so it uses the rule, file, line and a rule-specific
// key (e.g. the event type) – never the message text, which may be reworded.
export function makeFinding({ rule, severity, file, line = null, component = null, message, fix, snippet = null, key = '' }) {
  return {
    id: sha1(`${rule}|${file}|${line ?? ''}|${key}`).slice(0, 12),
    rule,
    severity,
    file,
    line,
    component,
    message,
    fix,
    snippet: snippet == null ? null : snippet.trim().slice(0, 140)
  };
}

export function sortFindings(findings) {
  return findings.sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity) || a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0)
  );
}

// Source text with its lines split once, so every finding can carry the offending line.
export class SourceText {
  constructor(text) {
    this.text = text;
    this.lines = text.split('\n');
  }

  line(number) {
    return number ? (this.lines[number - 1] ?? '').trim().slice(0, 140) : null;
  }
}

// The analysed project's own Babel: perf-tool ships without node_modules on purpose.
let babelCache = null;
export function loadBabel(repoRoot) {
  if (babelCache?.repoRoot === repoRoot) return babelCache.babel;
  const babel = (() => {
    const modulePath = path.join(repoRoot, 'node_modules/@babel/core');
    if (!fs.existsSync(modulePath)) throw new Error('@babel/core is not installed in the project (node_modules/@babel/core)');
    return createRequireFor(repoRoot)(modulePath);
  })();
  babelCache = { repoRoot, babel };
  return babel;
}

const createRequireFor = repoRoot => createRequire(path.join(repoRoot, 'package.json'));

const PARSER_PLUGINS = [
  'jsx',
  'typescript',
  'decorators-legacy',
  'classProperties',
  'classPrivateProperties',
  'classPrivateMethods',
  'dynamicImport',
  'exportDefaultFrom',
  'importMeta',
  'topLevelAwait'
];

// Flow files in React Native projects parse as TypeScript well enough for what we look at; errorRecovery keeps
// going past the odd syntax error so one bad line does not hide a whole file.
export function parseSource(babel, text, file) {
  // `.ts` files may use `<Type>value` assertions, which the jsx plugin would read as JSX.
  const plugins = /\.(m|c)?ts$/.test(file) ? PARSER_PLUGINS.filter(plugin => plugin !== 'jsx') : PARSER_PLUGINS;
  return babel.parseSync(text, {
    babelrc: false,
    configFile: false,
    filename: file,
    sourceType: 'unambiguous',
    parserOpts: { plugins, errorRecovery: true, allowReturnOutsideFunction: true }
  });
}

// tsconfig.json and friends allow comments and trailing commas; strings may contain "//" (URLs).
export function readJsonc(file) {
  const text = fs.readFileSync(file, 'utf8');
  let out = '';
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      const start = index;
      for (index++; index < text.length && text[index] !== '"'; index++) if (text[index] === '\\') index++;
      out += text.slice(start, index + 1);
    } else if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index++;
      out += '\n';
    } else if (char === '/' && text[index + 1] === '*') {
      index = text.indexOf('*/', index + 2);
      if (index === -1) break;
      index++;
    } else out += char;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function walkFiles(dir, accept, skipDir = /^(node_modules|\.git|__tests__|__mocks__)$/, files = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skipDir.test(entry.name)) walkFiles(full, accept, skipDir, files);
    } else if (accept(entry.name)) files.push(full);
  }
  return files;
}

export const kb = bytes => Math.round(bytes / 102.4) / 10;

// A short list for messages: "a, b, c and 4 more".
export function listText(items, max = 5) {
  if (items.length <= max) return items.join(', ');
  return `${items.slice(0, max).join(', ')} and ${items.length - max} more`;
}
