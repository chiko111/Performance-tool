#!/usr/bin/env node
// React Compiler status for every component in src/ (and the core package): compiled with how many
// memo slots, or the exact reason the compiler bailed out. Results are cached per file mtime.
//
//   perf compiler                 refresh cache, print failures
//   perf compiler HomeScreen      only files whose path contains the text
//   perf compiler --all           print every component

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { sourceRoots, sourceFiles, definitionsIn } from './component-index.mjs';

const require = createRequire(import.meta.url);
const repoFlag = process.argv.indexOf('--repo');
const repoRoot = path.resolve(repoFlag === -1 ? process.env.PERF_REPO ?? process.cwd() : process.argv[repoFlag + 1]);
const repoKey = `${path.basename(repoRoot)}-${crypto.createHash('sha1').update(repoRoot).digest('hex').slice(0, 8)}`;
export const CACHE_FILE = path.join(os.homedir(), 'perf-results', `.compiler-cache-${repoKey}.json`);

function compilerEvents(file) {
  const { transformFileSync } = require(path.join(repoRoot, 'node_modules/@babel/core'));
  const events = [];
  transformFileSync(file, {
    babelrc: false,
    configFile: false,
    cwd: repoRoot,
    compact: true,
    presets: [['@babel/preset-typescript', { isTSX: true, allExtensions: true }]],
    plugins: [
      '@babel/plugin-syntax-jsx',
      ['babel-plugin-react-compiler', { panicThreshold: 'none', logger: { logEvent: (_, event) => events.push(event) } }]
    ]
  });
  return events;
}

function nameAt(definitions, line) {
  let best = null;
  for (const definition of definitions) {
    if (definition.line <= line && line - definition.line <= 3) best = definition;
  }
  return best?.name ?? null;
}

function reportFile(file, relative) {
  const source = fs.readFileSync(file, 'utf8');
  const definitions = definitionsIn(source);
  const byFunction = new Map();
  let events;
  try {
    events = compilerEvents(file);
  } catch (error) {
    return [{ component: null, file: relative, line: null, status: 'parse-error', reasons: [error.message.split('\n')[0]] }];
  }
  for (const event of events) {
    const line = event.fnLoc?.start?.line ?? null;
    const name = event.fnName ?? nameAt(definitions, line);
    if (!name || !/^[A-Z]/.test(name)) continue; // hooks/helpers are not rendered components
    const entry = byFunction.get(name) ?? { component: name, file: relative, line, status: null, memoSlots: 0, reasons: [] };
    if (event.kind === 'CompileSuccess') {
      entry.status = entry.status === 'error' ? 'error' : 'compiled';
      entry.memoSlots = event.memoSlots;
    } else if (event.kind === 'CompileError') {
      entry.status = 'error';
      const options = event.detail?.options ?? event.detail ?? {};
      const at = options.loc?.start?.line ?? options.loc?.line;
      entry.reasons.push(`${options.reason ?? 'unknown'}${at ? ` (line ${at})` : ''}`);
    } else if (event.kind === 'CompileSkip') {
      entry.status = entry.status ?? 'skipped';
      // The plugin puts the directive node into the text ("'[object Object]' directive").
      const directive = /use no (memo|forget)/.test(fs.readFileSync(file, 'utf8')) ? "'use no memo'" : 'a directive';
      entry.reasons.push(String(event.reason ?? 'skipped').replace("'[object Object]' directive", `${directive} (opted out on purpose)`));
    } else if (event.kind === 'PipelineError') {
      entry.status = 'error';
      entry.reasons.push(String(event.data ?? 'pipeline error').split('\n')[0]);
    }
    byFunction.set(name, entry);
  }
  // A component the compiler never reported (e.g. class components) is not memoized.
  for (const { name, line } of definitions) {
    if (!byFunction.has(name) && /^\s*(export\s+)?(default\s+)?class\s/m.test(source.split('\n')[line - 1] ?? '')) {
      byFunction.set(name, { component: name, file: relative, line, status: 'class', memoSlots: 0, reasons: ['class component (not supported by the compiler)'] });
    }
  }
  return [...byFunction.values()].map(entry => ({ ...entry, reasons: uniqueReasons(entry.reasons) }));
}

function uniqueReasons(reasons) {
  const counts = new Map();
  for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return [...counts.entries()].map(([reason, count]) => (count > 1 ? `${reason} ×${count}` : reason));
}

export function loadCompilerCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return { files: {} };
  }
}

export function refreshCompilerReport(filter) {
  const cache = loadCompilerCache();
  let compiledFiles = 0;
  for (const root of sourceRoots(repoRoot)) {
    for (const file of sourceFiles(root.dir)) {
      const relative = path.join(root.prefix, path.relative(root.dir, file));
      if (filter && !relative.includes(filter)) continue;
      const mtime = fs.statSync(file).mtimeMs;
      if (cache.files[relative]?.mtime === mtime) continue;
      cache.files[relative] = { mtime, components: reportFile(file, relative) };
      compiledFiles += 1;
    }
  }
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  return { cache, compiledFiles };
}

// component name -> compiler entry (first definition wins; duplicates keep all files).
export function compilerIndex(cache) {
  const index = new Map();
  for (const { components } of Object.values(cache.files)) {
    for (const entry of components) if (entry.component && !index.has(entry.component)) index.set(entry.component, entry);
  }
  return index;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const filter = args.find((arg, index) => !arg.startsWith('--') && args[index - 1] !== '--repo');
  const started = Date.now();
  const { cache, compiledFiles } = refreshCompilerReport(filter);
  const rows = Object.entries(cache.files)
    .filter(([file]) => !filter || file.includes(filter))
    .flatMap(([, value]) => value.components);
  const counts = rows.reduce((acc, row) => ({ ...acc, [row.status]: (acc[row.status] ?? 0) + 1 }), {});
  console.log(`Analysed ${compiledFiles} changed files in ${Math.round((Date.now() - started) / 1000)}s. Components:`, counts);
  const shown = args.includes('--all') ? rows : rows.filter(row => row.status !== 'compiled');
  for (const row of shown.sort((a, b) => a.file.localeCompare(b.file))) {
    const mark = row.status === 'compiled' ? `✓ memoized (${row.memoSlots} slots)` : `✗ ${row.status}`;
    console.log(`${mark.padEnd(24)} ${row.component ?? '(file)'}  ${row.file}:${row.line ?? ''}`);
    for (const reason of row.reasons) console.log(`${''.padEnd(26)}↳ ${reason}`);
  }
}
