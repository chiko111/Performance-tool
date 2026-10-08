#!/usr/bin/env node
// Static "code health" analysis of a React / React Native project: effect leaks, Redux selectors that re-render on
// every dispatch, context providers with inline values, circular imports, dependencies, heavy assets and CSS.
// Precision over recall: every rule skips what it cannot see clearly, because one false positive makes people
// ignore the whole list.
//
//   node lib/code-health.mjs --repo <path> [--json] [--sections leaks,selectors,...] [--stats <perf-stats.json>] [--offline]
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceFiles } from './component-index.mjs';
import { projectConfig, sourceRootsOf } from './config.mjs';
import { runAssets } from './code-health/assets.mjs';
import { loadBabel, makeFinding, readJson, severityRank, sortFindings, SEVERITIES } from './code-health/common.mjs';
import { runCss } from './code-health/css.mjs';
import { runDependencies } from './code-health/deps.mjs';
import { findCycles } from './code-health/imports.mjs';
import { analyzeJsFile } from './code-health/js-analysis.mjs';
import { createResolver, packageNameOf } from './code-health/resolve.mjs';

export const SECTIONS = ['leaks', 'selectors', 'context', 'circular', 'dependencies', 'assets', 'css'];
const JS_SECTIONS = new Set(['leaks', 'selectors', 'context', 'circular', 'dependencies', 'css']);

export function detectKind(repoRoot, project = null) {
  if (project?.kind === 'web') return 'web';
  const pkg = readJson(path.join(repoRoot, 'package.json')) ?? {};
  return pkg.dependencies?.['react-native'] || pkg.devDependencies?.['react-native'] ? 'react-native' : 'web';
}

// ---------- the JavaScript pass ----------

function analyzeSources(repoRoot, roots, kind, sections, progress, errors) {
  const babel = loadBabel(repoRoot);
  const files = roots.flatMap(root =>
    sourceFiles(root.dir).map(file => ({ file, relative: path.join(root.prefix, path.relative(root.dir, file)) }))
  );
  const results = new Map();
  let done = 0;
  for (const { file, relative } of files) {
    if (++done % 250 === 0) progress(`Parsing source files ${done}/${files.length}`);
    try {
      const text = fs.readFileSync(file, 'utf8');
      const result = analyzeJsFile({ babel, file, relative, text, kind, sections });
      result.relative = relative;
      results.set(file, result);
      errors.push(...result.errors);
    } catch (error) {
      errors.push({ section: 'source', file: relative, message: `could not parse: ${error.message.split('\n')[0].slice(0, 200)}` });
    }
  }
  return results;
}

// Findings with the same id (e.g. a helper called from two effects) are reported once.
const finalize = items => sortFindings([...new Map(items.map(item => makeFinding(item)).map(finding => [finding.id, finding])).values()]);

// Follows re-exports (barrels) to the file that defines `name`, at most a few hops. `pick` selects the per-file
// definitions to look in (selector functions, effect wrappers).
function findExport(results, resolver, file, name, depth = 0, pick = result => result.selectorDefs) {
  const result = results.get(file);
  if (!result || depth > 4) return null;
  const def = pick(result).get(name);
  if (def) return { def, file: result.relative };
  for (const reexport of result.reexports) {
    const target = resolver.resolve(file, reexport.spec);
    if (!target) continue;
    if (reexport.names === null) {
      const found = findExport(results, resolver, target, name, depth + 1, pick);
      if (found) return found;
    } else {
      const match = reexport.names.find(item => item.exported === name);
      if (match) return findExport(results, resolver, target, match.local, depth + 1, pick);
    }
  }
  return null;
}

// ---------- effect wrappers that drop the returned cleanup ----------

// A package hook such as `useMount(cb)` implemented as `useEffect(() => { cb() }, [])`: recognised in the package's
// built file (plain or minified webpack output). Anything else is 'unknown' and never reported.
function packageWrapperSemantics(repoRoot, name, hook, cache) {
  const key = `${name}#${hook}`;
  if (cache.has(key)) return cache.get(key);
  let verdict = null;
  try {
    const dir = path.join(repoRoot, 'node_modules', name);
    const manifest = readJson(path.join(dir, 'package.json')) ?? {};
    for (const entry of [...new Set([manifest.module, manifest.main, 'index.js'].filter(Boolean))]) {
      const file = path.resolve(dir, entry);
      if (!fs.existsSync(file) || fs.statSync(file).size > 8 * 1024 * 1024) continue;
      const text = fs.readFileSync(file, 'utf8');
      const escape = value => value.replace(/[$]/g, '\\$');
      const local = text.match(new RegExp(`\\b${escape(hook)}:(?:\\(\\)=>|function\\(\\)\\{return )([\\w$]+)`))?.[1] ?? hook;
      const id = escape(local);
      const effect = '(?:\\(0,\\s*[\\w$]+\\.useEffect\\)|(?:React\\.)?useEffect)';
      const patterns = [
        `\\b${id}=function\\((\\w+)\\)\\{(?:var [^;{}]*;)?${effect}\\(function\\(\\)\\{\\1\\(\\)\\}`,
        `function ${id}\\((\\w+)[^)]*\\)\\s*\\{\\s*${effect}\\(\\s*(?:function\\s*\\(\\)|\\(\\)\\s*=>)\\s*\\{\\s*\\1\\(\\);?\\s*\\}`,
        `\\b${id}\\s*=\\s*\\(?(\\w+)[^)=]*\\)?\\s*=>\\s*\\{\\s*${effect}\\(\\s*(?:function\\s*\\(\\)|\\(\\)\\s*=>)\\s*\\{\\s*\\1\\(\\);?\\s*\\}`
      ];
      if (patterns.some(pattern => new RegExp(pattern).test(text))) {
        verdict = 'discards';
        break;
      }
    }
  } catch {}
  cache.set(key, verdict);
  return verdict;
}

function ignoredCleanups(results, resolver, repoRoot) {
  const cache = new Map();
  const items = [];
  for (const [file, result] of results) {
    for (const call of result.wrapperCalls) {
      let semantics = null;
      let origin = null;
      if (call.local) {
        semantics = result.effectWrappers.get(call.local) ?? null;
        origin = 'this file';
      } else if (call.source) {
        const target = resolver.resolve(file, call.source);
        if (target) {
          const hit = findExport(results, resolver, target, call.imported, 0, item => item.effectWrappers);
          semantics = hit?.def ?? null;
          origin = hit?.file;
        } else if (packageNameOf(call.source)) {
          semantics = packageWrapperSemantics(repoRoot, packageNameOf(call.source), call.imported, cache);
          origin = packageNameOf(call.source);
        }
      }
      if (semantics !== 'discards') continue;
      items.push({
        rule: 'effect-cleanup-ignored',
        severity: 'high',
        file: result.relative,
        line: call.line,
        component: call.component,
        key: call.hook,
        snippet: call.snippet,
        message: `${call.hook} (${origin}) runs its callback inside useEffect but ignores what it returns, so the cleanup returned here never runs: whatever it removes (listeners, timers, subscriptions) leaks on every unmount.`,
        fix: `Use useEffect directly for effects that need a cleanup (or make ${call.hook} return the callback's result).`
      });
    }
  }
  return items;
}

function selectorsSection(results, resolver) {
  for (const [file, result] of results) {
    for (const item of result.deferredSelectors) {
      let found = null;
      if (item.local) {
        const def = result.selectorDefs.get(item.local);
        if (def) found = { def, via: `${item.local}, line ${def.line}` };
      } else {
        const target = resolver.resolve(file, item.source);
        const hit = target ? findExport(results, resolver, target, item.imported) : null;
        if (hit) found = { def: hit.def, via: `${item.imported} in ${hit.file}:${hit.def.line}` };
      }
      if (found?.def.kind) item.reportNew(found.def, found.via);
    }
  }
  return { findings: finalize([...results.values()].flatMap(result => result.findings.selectors)) };
}

// ---------- React Compiler status for context providers ----------

// Newer compiler-report.mjs takes the repo as an argument; older ones use the --repo/PERF_REPO seen at import
// time, so for another repo read its cache file directly (same naming scheme).
async function compilerStatus(repoRoot) {
  const pkg = readJson(path.join(repoRoot, 'package.json')) ?? {};
  const usesCompiler = Boolean(pkg.dependencies?.['babel-plugin-react-compiler'] || pkg.devDependencies?.['babel-plugin-react-compiler']);
  if (!usesCompiler) return { usesCompiler, files: null };
  try {
    const report = await import('./compiler-report.mjs');
    let cache = report.loadCompilerCache(repoRoot);
    const key = `${path.basename(repoRoot)}-${crypto.createHash('sha1').update(repoRoot).digest('hex').slice(0, 8)}`;
    const ownFile = path.join(os.homedir(), 'perf-results', `.compiler-cache-${key}.json`);
    if (!report.cacheFileFor && report.CACHE_FILE !== ownFile) {
      const other = readJson(ownFile);
      cache = other?.version === cache.version ? other : { files: {} };
    }
    return { usesCompiler, files: cache.files ?? {} };
  } catch {
    return { usesCompiler, files: {} };
  }
}

async function contextSection(repoRoot, results) {
  const compiler = await compilerStatus(repoRoot);
  const items = [];
  for (const [file, result] of results) {
    for (const candidate of result.contextCandidates) {
      let status = 'not-compiled';
      if (compiler.usesCompiler) {
        const entry = compiler.files?.[result.relative];
        const fresh = entry && Math.abs(entry.mtime - fs.statSync(file).mtimeMs) < 1;
        const component = fresh ? entry.components.find(item => item.component === candidate.component) : null;
        status = component ? (component.status === 'compiled' ? 'compiled' : 'not-compiled') : 'unknown';
      }
      if (status === 'compiled') continue;
      const what = candidate.valueKind === 'function' ? 'an inline function' : `an inline ${candidate.valueKind}`;
      items.push({
        rule: 'context-inline-value',
        severity: status === 'not-compiled' ? 'high' : 'low',
        file: result.relative,
        line: candidate.line,
        component: candidate.component,
        key: candidate.provider,
        snippet: candidate.snippet,
        message:
          `${candidate.provider} gets ${what} as value, a new reference on every render of ${candidate.component ?? 'its component'}, so every consumer re-renders each time` +
          (status === 'unknown'
            ? ' (React Compiler status unknown: run `perf compiler` – if the component is compiled this is already memoized).'
            : compiler.usesCompiler
              ? ' (React Compiler did not compile this component).'
              : '.'),
        fix: 'Wrap the value in useMemo (and callbacks in useCallback) with the right dependencies, or let React Compiler compile the component.'
      });
    }
  }
  return { findings: finalize(items) };
}

function circularSection(results, resolver) {
  const graph = new Map();
  const barrels = new Set();
  for (const [file, result] of results) {
    if (result.barrel) barrels.add(file);
    const edges = [];
    for (const item of result.imports) {
      if (item.dynamic || item.typeOnly) continue;
      const target = resolver.resolve(file, item.spec);
      if (!target || target === file || !results.has(target) || edges.some(edge => edge.to === target)) continue;
      edges.push({ to: target, line: item.line });
    }
    graph.set(file, edges);
  }
  return { cycles: findCycles(graph, file => results.get(file).relative, barrels) };
}

// ---------- entry point ----------

export async function runCodeHealth(repoRoot, options = {}) {
  repoRoot = path.resolve(repoRoot);
  const started = Date.now();
  const progress = options.onProgress ?? (() => {});
  const project = options.project !== undefined ? options.project : projectConfig(repoRoot);
  const kind = options.kind ?? detectKind(repoRoot, project);
  const roots = sourceRootsOf(repoRoot, project);
  const applicable = SECTIONS.filter(section => section !== 'css' || kind === 'web');
  const sections = new Set((options.sections?.length ? options.sections : applicable).filter(section => applicable.includes(section)));
  const errors = [];
  const report = { version: 1, generatedAt: new Date().toISOString(), repo: repoRoot, kind, tookMs: 0, sections: {}, errors };
  const ctx = { repoRoot, kind, roots, project, offline: Boolean(options.offline), statsFile: options.statsFile ?? null, progress, errors };
  ctx.resolver = createResolver(repoRoot, { kind, sourceDirs: roots.map(root => root.dir) });
  ctx.stats = null;
  if (ctx.statsFile) {
    try {
      ctx.stats = JSON.parse(fs.readFileSync(path.resolve(ctx.statsFile), 'utf8'));
    } catch (error) {
      errors.push({ section: 'stats', file: ctx.statsFile, message: `could not read the stats file: ${error.message}` });
    }
  }

  if ([...sections].some(section => JS_SECTIONS.has(section))) {
    progress('Parsing source files');
    try {
      ctx.js = analyzeSources(repoRoot, roots, kind, sections, progress, errors);
    } catch (error) {
      errors.push({ section: 'source', file: null, message: error.message });
      ctx.js = new Map();
    }
  }

  const runners = {
    leaks: () => ({
      findings: finalize([...[...ctx.js.values()].flatMap(result => result.findings.leaks), ...ignoredCleanups(ctx.js, ctx.resolver, repoRoot)])
    }),
    selectors: () => selectorsSection(ctx.js, ctx.resolver),
    context: () => contextSection(repoRoot, ctx.js),
    circular: () => circularSection(ctx.js, ctx.resolver),
    dependencies: () => runDependencies(ctx),
    assets: () => runAssets(ctx),
    css: () => runCss(ctx)
  };
  const empty = {
    leaks: { findings: [] },
    selectors: { findings: [] },
    context: { findings: [] },
    circular: { cycles: [] },
    dependencies: { outdated: [], vulnerabilities: [], unused: [], duplicates: [], heavy: [], skipped: [] },
    assets: { findings: [] },
    css: { findings: [], stats: { files: 0, modules: 0, rules: 0, importantCount: 0, colorLiterals: 0, cssKbByChunk: [] } }
  };
  for (const section of SECTIONS) {
    if (!sections.has(section)) continue;
    progress(`Checking ${section}`);
    try {
      report.sections[section] = await runners[section]();
    } catch (error) {
      errors.push({ section, file: null, message: error.message });
      report.sections[section] = empty[section];
    }
  }
  report.tookMs = Date.now() - started;
  return report;
}

// ---------- Markdown ----------

const value = item => (item == null || Number.isNaN(item) ? '–' : String(item));
const cell = item => value(item).replace(/\|/g, '\\|').replace(/\n/g, ' ');

function table(columns, rows) {
  if (!rows.length) return '_none_\n';
  const header = `| ${columns.map(column => column.label).join(' | ')} |`;
  const divider = `| ${columns.map(column => (column.num ? '---:' : '---')).join(' | ')} |`;
  const body = rows.map(row => `| ${columns.map(column => cell(column.get(row))).join(' | ')} |`);
  return [header, divider, ...body].join('\n') + '\n';
}

const where = finding => (finding.line ? `${finding.file}:${finding.line}` : finding.file);
const FINDING_COLUMNS = [
  { label: 'Severity', get: row => row.severity },
  { label: 'Rule', get: row => row.rule },
  { label: 'Where', get: row => where(row) },
  { label: 'Component', get: row => row.component ?? '–' },
  { label: 'Problem', get: row => row.message },
  { label: 'Fix', get: row => row.fix }
];
const TITLES = {
  leaks: 'Leaks (effects and listeners that outlive the component)',
  selectors: 'Redux selectors',
  context: 'Context providers',
  circular: 'Circular imports',
  dependencies: 'Dependencies',
  assets: 'Heavy assets',
  css: 'CSS'
};

function countsBySeverity(findings) {
  const counts = Object.fromEntries(SEVERITIES.map(severity => [severity, 0]));
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

// Markdown tables stop here; the JSON report has everything.
const MAX_ROWS = 60;
const capped = (rows, render) =>
  render(rows.slice(0, MAX_ROWS)) + (rows.length > MAX_ROWS ? `_…and ${rows.length - MAX_ROWS} more (see the JSON report)_\n` : '');
// "Fix first" prefers runtime problems (leaks, re-renders) over hygiene at the same severity.
const FIX_PRIORITY = ['leaks', 'selectors', 'context', 'assets', 'css'];

function summaryText(report) {
  const lines = [];
  const all = [];
  for (const [name, section] of Object.entries(report.sections)) {
    if (section.findings) {
      const counts = countsBySeverity(section.findings);
      all.push(...section.findings.map(finding => ({ ...finding, section: name })));
      lines.push(
        section.findings.length
          ? `- ${TITLES[name].split(' (')[0]}: ${counts.high} high, ${counts.medium} medium, ${counts.low} low.`
          : `- ${TITLES[name].split(' (')[0]}: nothing found.`
      );
    } else if (name === 'circular') {
      lines.push(`- Circular imports: ${section.cycles.length ? `${section.cycles.length} import cycle${section.cycles.length === 1 ? '' : 's'}` : 'none'}.`);
    } else if (name === 'dependencies') {
      const vulnerable = ['critical', 'high', 'moderate', 'low'].map(severity => [severity, section.vulnerabilities.filter(item => item.severity === severity).length]);
      const vulnText = vulnerable.filter(([, count]) => count).map(([severity, count]) => `${count} ${severity}`).join(', ');
      lines.push(
        `- Dependencies: ${section.outdated.length} outdated (${section.outdated.filter(item => item.deprecated).length} deprecated, ` +
          `${section.outdated.filter(item => item.majorsBehind > 0).length} a major version behind), ` +
          `${section.vulnerabilities.length} known vulnerabilities${vulnText ? ` (${vulnText})` : ''}, ${section.unused.length} possibly unused, ` +
          `${section.duplicates.length} duplicated.`
      );
    }
  }
  const top = all
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || FIX_PRIORITY.indexOf(a.section) - FIX_PRIORITY.indexOf(b.section))
    .slice(0, 5);
  const fixes = top.map(finding => `${finding.severity === 'high' ? '**' : ''}${where(finding)}${finding.severity === 'high' ? '**' : ''} – ${finding.message}`);
  const critical = report.sections.dependencies?.vulnerabilities.filter(item => item.severity === 'critical' || item.severity === 'high') ?? [];
  if (critical.length) fixes.unshift(`**${critical.length} high/critical vulnerabilities** in dependencies, e.g. ${critical[0].name}@${critical[0].version}: ${critical[0].title}.`);
  return `## Summary
Analysed ${report.repo} (${report.kind}) in ${Math.round(report.tookMs / 100) / 10} s.

${lines.join('\n')}

### Fix first
${fixes.length ? fixes.slice(0, 5).map((text, index) => `${index + 1}. ${text}`).join('\n') : '_nothing urgent_'}
`;
}

function dependenciesText(deps) {
  return `### Outdated
_Minors behind: minor releases since the installed one, or on the latest major when a major behind._
${table(
  [
    { label: 'Package', get: row => row.name },
    { label: 'Type', get: row => (row.type === 'devDependencies' ? 'dev' : 'prod') },
    { label: 'Installed', get: row => row.installed },
    { label: 'Latest', get: row => row.latest },
    { label: 'Majors behind', num: true, get: row => row.majorsBehind },
    { label: 'Minors behind', num: true, get: row => row.minorsBehind },
    { label: 'Deprecated', get: row => row.deprecated ?? '–' }
  ],
  deps.outdated
)}
### Known vulnerabilities (installed versions, whole tree)
${capped(deps.vulnerabilities, rows => table(
  [
    { label: 'Severity', get: row => row.severity },
    { label: 'Package', get: row => `${row.name}@${row.version}` },
    { label: 'Via', get: row => row.dependencyOf ?? '–' },
    { label: 'Advisory', get: row => row.title },
    { label: 'Vulnerable', get: row => row.vulnerableVersions },
    { label: 'Link', get: row => row.url }
  ],
  rows
))}
### Possibly unused
${table(
  [
    { label: 'Package', get: row => row.name },
    { label: 'Note', get: row => row.note }
  ],
  deps.unused
)}
### Duplicated packages
${capped(deps.duplicates, rows => table(
  [
    { label: 'Package', get: row => row.name },
    { label: 'Versions', get: row => row.versions.map(item => `${item.version ?? '?'}${item.kb != null ? ` (${item.kb} kB)` : ''}`).join(', ') }
  ],
  rows
))}
### Heaviest packages
${table(
  [
    { label: 'Package', get: row => row.name },
    { label: 'kB', num: true, get: row => row.kb },
    { label: '% of JS', num: true, get: row => row.share },
    { label: 'Note', get: row => row.note ?? '–' }
  ],
  deps.heavy
)}
${deps.skipped.length ? `Not checked: ${deps.skipped.map(item => `${item.name} (${item.reason})`).join(', ')}.\n` : ''}`;
}

function cyclesText(circular) {
  if (!circular.cycles.length) return '_none_\n';
  return circular.cycles
    .map(
      (cycle, index) =>
        `${index + 1}. ${cycle.edges.map(edge => `${edge.from}:${edge.line ?? '?'}`).join(' → ')} → ${cycle.files[0]}` +
        `${cycle.viaBarrel ? ' _(through a barrel index file)_' : ''}${cycle.filesInGroup > cycle.files.length ? ` _(${cycle.filesInGroup} files are tangled in this group)_` : ''}`
    )
    .join('\n') + '\n';
}

export function codeHealthToMarkdown(report) {
  const parts = [`# Code health: ${path.basename(report.repo)}\n_${report.generatedAt}_\n`, summaryText(report)];
  for (const [name, section] of Object.entries(report.sections)) {
    parts.push(`## ${TITLES[name]}`);
    if (name === 'circular') parts.push(cyclesText(section));
    else if (name === 'dependencies') parts.push(dependenciesText(section));
    else parts.push(capped(section.findings, rows => table(FINDING_COLUMNS, rows)));
    if (name === 'css' && section.stats) {
      const stats = section.stats;
      parts.push(
        `${stats.files} style files (${stats.modules} CSS modules), ${stats.rules} rules, ${stats.importantCount} !important, ${stats.colorLiterals} hard-coded colours.\n` +
          (stats.cssKbByChunk.length
            ? table(
                [
                  { label: 'Chunk', get: row => row.chunk },
                  { label: 'CSS kB', num: true, get: row => row.kb },
                  { label: 'Initial', get: row => (row.initial ? 'yes' : 'no') }
                ],
                stats.cssKbByChunk
              )
            : '')
      );
    }
  }
  if (report.errors.length) {
    parts.push(`## Errors\n${report.errors.map(error => `- ${error.section}${error.file ? ` ${error.file}` : ''}: ${error.message}`).join('\n')}\n`);
  }
  return parts.join('\n');
}

// ---------- CLI ----------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = name => {
    const index = args.indexOf(`--${name}`);
    return index === -1 ? undefined : args[index + 1];
  };
  const repo = path.resolve(option('repo') ?? process.cwd());
  // compiler-report.mjs reads --repo from argv when imported; make sure it sees the same repo.
  if (!process.argv.includes('--repo')) process.argv.push('--repo', repo);
  const sections = option('sections')?.split(',').map(item => item.trim()).filter(Boolean);
  const unknown = sections?.filter(item => !SECTIONS.includes(item)) ?? [];
  if (unknown.length) {
    console.error(`code-health: unknown section(s) ${unknown.join(', ')} (known: ${SECTIONS.join(', ')})`);
    process.exit(2);
  }
  const json = args.includes('--json');
  try {
    const report = await runCodeHealth(repo, {
      sections,
      statsFile: option('stats'),
      offline: args.includes('--offline'),
      onProgress: text => process.stderr.write(`… ${text}\n`)
    });
    console.log(json ? JSON.stringify(report, null, 2) : codeHealthToMarkdown(report));
  } catch (error) {
    console.error(`code-health: ${error.message}`);
    process.exit(1);
  }
}
