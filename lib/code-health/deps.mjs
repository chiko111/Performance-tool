// Dependencies: outdated/deprecated (npm registry), known vulnerabilities (npm bulk advisory API, whole lockfile
// tree), possibly unused, duplicated and heavy packages. Network calls are cached and optional (--offline).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { kb, readJson, walkFiles } from './common.mjs';
import { packageNameOf } from './resolve.mjs';

const REGISTRY = 'https://registry.npmjs.org';
const CACHE_DIR = process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Caches/perf-tool') : path.join(os.homedir(), '.cache/perf-tool');
const META_CACHE = path.join(CACHE_DIR, 'npm-meta.json');
const ADVISORY_CACHE = path.join(CACHE_DIR, 'npm-advisories.json');
const CACHE_MS = 12 * 3600 * 1000;
const CONCURRENCY = 8;
const TIMEOUT_MS = 10000;
const SEVERITY_ORDER = ['critical', 'high', 'moderate', 'low'];

// Packages people usually replace once they see the cost; only well-known, uncontroversial swaps.
const REPLACEABLE = {
  moment: 'moment is large and not tree-shakeable: date-fns or dayjs cover most uses',
  'moment-timezone': 'bundles the timezone database: Intl.DateTimeFormat or date-fns-tz',
  lodash: 'the full CommonJS build: lodash-es or per-method imports (lodash/debounce) tree-shake',
  underscore: 'mostly covered by modern built-ins (Array/Object methods)',
  jquery: 'rarely needed next to React',
  'core-js': 'polyfills: make sure only the ones your browserslist needs are included'
};

// ---------- semver (just enough: x.y.z with optional prerelease) ----------

export function parseVersion(text) {
  const match = String(text ?? '').trim().replace(/^[v=]/, '').match(/^(\d+)(?:\.(\d+|[x*]))?(?:\.(\d+|[x*]))?(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/);
  if (!match) return null;
  const part = value => (value == null || value === 'x' || value === '*' ? 0 : Number(value));
  return { major: part(match[1]), minor: part(match[2]), patch: part(match[3]), pre: match[4] ?? null };
}

export function compareVersions(a, b) {
  const left = typeof a === 'string' ? parseVersion(a) : a;
  const right = typeof b === 'string' ? parseVersion(b) : b;
  for (const key of ['major', 'minor', 'patch']) if (left[key] !== right[key]) return left[key] - right[key];
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  const leftParts = left.pre.split('.');
  const rightParts = right.pre.split('.');
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index++) {
    const x = leftParts[index];
    const y = rightParts[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x) ? Number(x) : null;
    const ny = /^\d+$/.test(y) ? Number(y) : null;
    if (nx !== null && ny !== null && nx !== ny) return nx - ny;
    if (nx === null || ny === null) {
      if (x !== y) return nx !== null ? -1 : ny !== null ? 1 : x < y ? -1 : 1;
    }
  }
  return 0;
}

// Advisory ranges: `<1.2.3`, `>=1.0.0 <1.2.3`, `>= 2.0.0`, `1.2.3`, `*`, joined with `||`.
export function satisfies(version, range) {
  const parsed = parseVersion(version);
  if (!parsed || !range) return false;
  return range.split('||').some(alternative => {
    const comparators = alternative.trim().replace(/(<=|>=|<|>|=)\s+/g, '$1').split(/\s+/).filter(Boolean);
    if (!comparators.length || comparators.includes('*')) return true;
    return comparators.every(comparator => {
      const match = comparator.match(/^(<=|>=|<|>|=)?(.+)$/);
      const target = parseVersion(match[2]);
      if (!target) return false;
      const order = compareVersions(parsed, target);
      switch (match[1]) {
        case '<':
          return order < 0;
        case '<=':
          return order <= 0;
        case '>':
          return order > 0;
        case '>=':
          return order >= 0;
        default:
          return order === 0;
      }
    });
  });
}

// ---------- small utilities ----------

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function readCache(file) {
  const cache = readJson(file);
  return cache?.version === 1 ? cache : { version: 1, entries: {} };
}

function writeCache(file, cache) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cache));
  } catch {}
}

// Only the `@scope:registry=` lines: everything else in .npmrc (auth tokens!) is ignored and never kept.
function scopedRegistries(repoRoot) {
  const scopes = new Set();
  try {
    for (const line of fs.readFileSync(path.join(repoRoot, '.npmrc'), 'utf8').split('\n')) {
      const match = line.match(/^\s*(@[\w.-]+):registry\s*=/);
      if (match) scopes.add(match[1]);
    }
  } catch {}
  return scopes;
}

const installedVersion = (repoRoot, name) => readJson(path.join(repoRoot, 'node_modules', name, 'package.json'))?.version ?? null;

function skipReason(spec) {
  if (/^(git|git\+\w+|github|gitlab|bitbucket|https?|file|link|workspace|portal|patch|exec):/.test(spec)) return `non-registry spec '${spec}'`;
  if (/^npm:/.test(spec)) return `aliased spec '${spec}'`;
  if (/^[\w.-]+\/[\w.-]+(#.*)?$/.test(spec)) return `GitHub spec '${spec}'`;
  if (/^[.~/]/.test(spec)) return `local path '${spec}'`;
  if (/^[A-Za-z][\w.-]*$/.test(spec) && !/^[vx]\d/i.test(spec) && spec !== 'x') return `tag spec '${spec}'`;
  return null;
}

// ---------- registry metadata ----------

async function fetchMeta(name, installed, cache, state) {
  const cached = cache.entries[name];
  if (cached && Date.now() - cached.at < CACHE_MS && (cached.missing || installed in (cached.deprecated ?? {}))) return cached;
  // Registry unreachable (first lookups all failed): do not wait for a timeout on every remaining package.
  if (state.offline || (state.failures.length >= CONCURRENCY && !state.successes)) return cached ?? null;
  try {
    const response = await fetch(`${REGISTRY}/${name.replace('/', '%2F')}`, {
      headers: { Accept: 'application/vnd.npm.install-v1+json' },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (response.status === 404) return (cache.entries[name] = { at: Date.now(), missing: true });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const doc = await response.json();
    state.successes = (state.successes ?? 0) + 1;
    const versions = Object.keys(doc.versions ?? {});
    // Latest stable: the `latest` dist-tag, unless it is a prerelease (then the highest stable version).
    let latest = doc['dist-tags']?.latest ?? null;
    if (!latest || parseVersion(latest)?.pre) {
      latest = versions.filter(version => parseVersion(version) && !parseVersion(version).pre).sort(compareVersions).pop() ?? latest;
    }
    const deprecated = { ...(cached?.deprecated ?? {}), [installed]: doc.versions?.[installed]?.deprecated?.slice(0, 300) ?? null };
    return (cache.entries[name] = { at: Date.now(), latest, deprecated });
  } catch (error) {
    state.failures.push(`${name}: ${error.name === 'TimeoutError' ? 'timed out' : error.message}`);
    return cached ?? null;
  }
}

async function outdatedSection(ctx, pkg, skipped) {
  const scopes = scopedRegistries(ctx.repoRoot);
  const candidates = [];
  for (const type of ['dependencies', 'devDependencies']) {
    for (const [name, spec] of Object.entries(pkg[type] ?? {})) {
      const reason = skipReason(String(spec));
      const scope = name.startsWith('@') ? name.split('/')[0] : null;
      if (reason) skipped.push({ name, reason });
      else if (scope && scopes.has(scope)) skipped.push({ name, reason: `${scope} uses its own registry (.npmrc)` });
      else {
        const installed = installedVersion(ctx.repoRoot, name);
        if (!installed) skipped.push({ name, reason: 'not installed (node_modules)' });
        else candidates.push({ name, type, spec, installed });
      }
    }
  }
  const cache = readCache(META_CACHE);
  const state = { offline: ctx.offline, failures: [], successes: 0 };
  ctx.progress(`Checking ${candidates.length} packages on the npm registry`);
  const metas = await mapLimit(candidates, CONCURRENCY, item => fetchMeta(item.name, item.installed, cache, state));
  writeCache(META_CACHE, cache);
  if (state.failures.length) {
    ctx.errors.push({
      section: 'dependencies',
      file: null,
      message: `npm registry: ${state.failures.length} of ${candidates.length} lookups failed (${state.failures.slice(0, 3).join('; ')})`
    });
  }
  const outdated = [];
  let unchecked = 0;
  candidates.forEach((item, index) => {
    const meta = metas[index];
    if (!meta) return unchecked++;
    if (meta.missing) return skipped.push({ name: item.name, reason: 'not on the public npm registry' });
    const installed = parseVersion(item.installed);
    const latest = parseVersion(meta.latest);
    const deprecated = meta.deprecated?.[item.installed] ?? null;
    if (!installed || !latest) return;
    const base = { ...installed, pre: null }; // a prerelease of x.y.z counts as x.y.z
    if (compareVersions(base, latest) >= 0 && !deprecated) return;
    const majorsBehind = Math.max(0, latest.major - installed.major);
    outdated.push({
      name: item.name,
      type: item.type,
      spec: item.spec,
      installed: item.installed,
      latest: meta.latest,
      majorsBehind,
      minorsBehind: majorsBehind ? latest.minor : Math.max(0, latest.minor - installed.minor),
      deprecated
    });
  });
  if (ctx.offline && unchecked) {
    ctx.errors.push({ section: 'dependencies', file: null, message: `offline: ${unchecked} packages have no cached registry data, outdated check skipped for them` });
  }
  return outdated.sort((a, b) => Number(Boolean(b.deprecated)) - Number(Boolean(a.deprecated)) || b.majorsBehind - a.majorsBehind || b.minorsBehind - a.minorsBehind);
}

// ---------- lockfiles ----------

const unquote = text => text.trim().replace(/^"(.*)"$/, '$1');
const descriptorName = descriptor => descriptor.slice(0, descriptor.indexOf('@', 1) === -1 ? descriptor.length : descriptor.indexOf('@', 1));

// yarn classic (v1) and yarn berry share the shape: descriptor lines, then indented fields and dependencies.
function parseYarnLock(text) {
  const entries = [];
  const byDescriptor = new Map();
  let current = null;
  let inDeps = false;
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    if (!line.startsWith(' ')) {
      const descriptors = line.replace(/:\s*$/, '').split(/,\s*/).map(item => item.replace(/"/g, '').trim());
      if (descriptors[0] === '__metadata') {
        current = null;
        continue;
      }
      current = { name: descriptorName(descriptors[0]), version: null, deps: [] };
      entries.push(current);
      for (const descriptor of descriptors) byDescriptor.set(descriptor, current);
      inDeps = false;
    } else if (current && /^ {2}\S/.test(line)) {
      const match = line.trim().match(/^"?([\w-]+)"?:?\s*(.*)$/);
      if (!match) continue;
      if (match[1] === 'version') current.version = unquote(match[2]);
      inDeps = /^(dependencies|optionalDependencies)$/.test(match[1]) && !match[2];
    } else if (current && inDeps && /^ {4}\S/.test(line)) {
      const match = line.trim().match(/^("?(?:@[^"\s:]+\/)?[^"\s:@]+"?):?\s+(.+)$/);
      if (match) current.deps.push({ name: unquote(match[1]), range: unquote(match[2]) });
    }
  }
  const resolve = (name, range) => byDescriptor.get(`${name}@${range}`) ?? byDescriptor.get(`${name}@npm:${range}`) ?? null;
  for (const entry of entries) entry.children = entry.deps.map(dep => resolve(dep.name, dep.range)).filter(Boolean);
  return entries.filter(entry => entry.version && !entry.version.includes('use.local'));
}

function parsePackageLock(lock) {
  const entries = new Map();
  for (const [key, value] of Object.entries(lock.packages ?? {})) {
    if (!key || !value.version || value.link) continue;
    entries.set(key, { name: key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length), version: value.version, raw: value, key });
  }
  for (const entry of entries.values()) {
    const names = Object.keys({ ...entry.raw.dependencies, ...entry.raw.optionalDependencies });
    entry.children = names
      .map(name => {
        // Node resolution: nearest node_modules/<name> walking up from this package.
        for (let base = entry.key; ; ) {
          const found = entries.get(`${base}/node_modules/${name}`);
          if (found) return found;
          const cut = base.lastIndexOf('/node_modules/');
          if (cut === -1) return entries.get(`node_modules/${name}`) ?? null;
          base = base.slice(0, cut);
        }
      })
      .filter(Boolean);
  }
  return [...entries.values()];
}

export function readLockfile(repoRoot) {
  const yarn = path.join(repoRoot, 'yarn.lock');
  if (fs.existsSync(yarn)) return { kind: 'yarn.lock', entries: parseYarnLock(fs.readFileSync(yarn, 'utf8')) };
  const npm = readJson(path.join(repoRoot, 'package-lock.json'));
  if (npm?.packages) return { kind: 'package-lock.json', entries: parsePackageLock(npm) };
  return null;
}

// The direct dependency that pulls `entry` in (shortest path up the lockfile graph).
function directParentOf(entry, parents, direct) {
  if (direct.has(entry.name)) return entry.name;
  const seen = new Set([entry]);
  const queue = [entry];
  while (queue.length) {
    const current = queue.shift();
    for (const parent of parents.get(current) ?? []) {
      if (direct.has(parent.name)) return parent.name;
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return null;
}

async function fetchAdvisories(body, ctx, cache) {
  const key = crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex');
  const cached = cache.entries[key];
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.data;
  if (ctx.offline) return cached?.data ?? null;
  const response = await fetch(`${REGISTRY}/-/npm/v1/security/advisories/bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS * 3)
  });
  if (!response.ok) throw new Error(`advisory API HTTP ${response.status}`);
  const data = await response.json();
  cache.entries[key] = { at: Date.now(), data };
  return data;
}

async function vulnerabilitiesSection(ctx, pkg, lock) {
  if (!lock) {
    ctx.errors.push({ section: 'dependencies', file: null, message: 'no yarn.lock or package-lock.json: vulnerability check skipped' });
    return [];
  }
  const versions = new Map();
  for (const entry of lock.entries) {
    if (!versions.has(entry.name)) versions.set(entry.name, new Set());
    versions.get(entry.name).add(entry.version);
  }
  const names = [...versions.keys()].sort();
  const chunks = [];
  for (let index = 0; index < names.length; index += 300) {
    chunks.push(Object.fromEntries(names.slice(index, index + 300).map(name => [name, [...versions.get(name)]])));
  }
  ctx.progress(`Checking ${names.length} installed packages for known vulnerabilities`);
  let advisories = {};
  let missing = 0;
  try {
    // One cache object for all chunks (they run in parallel), written once; stale entries are dropped.
    const cache = readCache(ADVISORY_CACHE);
    for (const [key, entry] of Object.entries(cache.entries)) if (Date.now() - entry.at > CACHE_MS) delete cache.entries[key];
    const results = await mapLimit(chunks, 4, chunk => fetchAdvisories(chunk, ctx, cache));
    writeCache(ADVISORY_CACHE, cache);
    for (const result of results) {
      if (result) Object.assign(advisories, result);
      else missing++;
    }
  } catch (error) {
    ctx.errors.push({ section: 'dependencies', file: null, message: `vulnerability check failed: ${error.name === 'TimeoutError' ? 'timed out' : error.message}` });
    return [];
  }
  if (missing) ctx.errors.push({ section: 'dependencies', file: null, message: 'offline: vulnerability check skipped (no cached advisory data)' });
  const parents = new Map();
  for (const entry of lock.entries) {
    for (const child of entry.children) {
      if (!parents.has(child)) parents.set(child, []);
      parents.get(child).push(entry);
    }
  }
  const direct = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);
  const found = new Map();
  for (const [name, list] of Object.entries(advisories)) {
    for (const advisory of list ?? []) {
      for (const entry of lock.entries.filter(item => item.name === name)) {
        if (!satisfies(entry.version, advisory.vulnerable_versions)) continue;
        const key = `${name}@${entry.version}#${advisory.id ?? advisory.url}`;
        if (found.has(key)) continue;
        found.set(key, {
          name,
          version: entry.version,
          severity: SEVERITY_ORDER.includes(advisory.severity) ? advisory.severity : 'low',
          title: advisory.title,
          url: advisory.url,
          vulnerableVersions: advisory.vulnerable_versions,
          dependencyOf: directParentOf(entry, parents, direct)
        });
      }
    }
  }
  return [...found.values()].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || a.name.localeCompare(b.name) || compareVersions(a.version, b.version)
  );
}

// ---------- unused ----------

// Root config files, .storybook and scripts/ mention packages that source files never import (plugins, presets,
// CLIs). package.json counts except for its dependency lists.
function configText(repoRoot, pkg) {
  const parts = [];
  const textFile = /\.(c|m)?[jt]sx?$|\.json$|\.ya?ml$|^\.[\w-]*rc$|\.ejs$|\.html$/;
  for (const entry of fs.readdirSync(repoRoot, { withFileTypes: true })) {
    if (entry.isFile() && textFile.test(entry.name) && entry.name !== 'package.json' && !/lock/.test(entry.name)) {
      const file = path.join(repoRoot, entry.name);
      if (fs.statSync(file).size < 512 * 1024) parts.push(fs.readFileSync(file, 'utf8'));
    }
  }
  // Native builds reference packages too (the RN gradle plugin, pods).
  for (const name of ['android/settings.gradle', 'android/build.gradle', 'android/app/build.gradle', 'ios/Podfile']) {
    const file = path.join(repoRoot, name);
    if (fs.existsSync(file)) parts.push(fs.readFileSync(file, 'utf8'));
  }
  for (const dir of ['.storybook', 'scripts', 'public', 'config']) {
    for (const file of walkFiles(path.join(repoRoot, dir), name => textFile.test(name)).slice(0, 300)) {
      if (fs.statSync(file).size < 512 * 1024) parts.push(fs.readFileSync(file, 'utf8'));
    }
  }
  const { dependencies, devDependencies, peerDependencies, optionalDependencies, resolutions, overrides, ...rest } = pkg;
  parts.push(JSON.stringify(rest));
  return parts.join('\n');
}

function styleImports(ctx) {
  const used = new Set();
  for (const root of ctx.roots) {
    for (const file of walkFiles(root.dir, name => /\.(s?css|sass|less)$/.test(name))) {
      const text = fs.readFileSync(file, 'utf8');
      for (const match of text.matchAll(/@(?:use|import|forward)\s+(?:url\()?['"]~?([^'"]+)['"]/g)) {
        const name = packageNameOf(match[1]);
        if (name && fs.existsSync(path.join(ctx.repoRoot, 'node_modules', name))) used.add(name);
      }
    }
  }
  return used;
}

function unusedSection(ctx, pkg) {
  const imported = new Set();
  for (const result of ctx.js?.values() ?? []) for (const name of result.packages) imported.add(name);
  for (const name of styleImports(ctx)) imported.add(name);
  const config = configText(ctx.repoRoot, pkg);
  const peers = new Set();
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const name of Object.keys(all)) {
    const manifest = readJson(path.join(ctx.repoRoot, 'node_modules', name, 'package.json'));
    for (const peer of Object.keys(manifest?.peerDependencies ?? {})) peers.add(peer);
  }
  const mentioned = name => new RegExp(`(?<![\\w-])${name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(?![\\w-])`).test(config);
  const unused = [];
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    if (imported.has(name) || name.startsWith('@types/') || peers.has(name) || mentioned(name)) continue;
    const dir = path.join(ctx.repoRoot, 'node_modules', name);
    const manifest = readJson(path.join(dir, 'package.json'));
    const bins = typeof manifest?.bin === 'string' ? [name.split('/').pop()] : Object.keys(manifest?.bin ?? {});
    if (bins.some(bin => mentioned(bin))) continue;
    if (ctx.kind === 'react-native' && isNativeModule(dir)) continue;
    unused.push({ name, type: 'dependencies', note: 'not imported from source — verify before removing' });
  }
  return unused;
}

function isNativeModule(dir) {
  try {
    return fs.existsSync(path.join(dir, 'android')) || fs.existsSync(path.join(dir, 'ios')) || fs.readdirSync(dir).some(name => name.endsWith('.podspec'));
  } catch {
    return false;
  }
}

// ---------- duplicates / heavy ----------

function dirBytes(dir, onlyScripts, seen = { bytes: 0 }) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return seen.bytes;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || (onlyScripts && /^(android|ios|__tests__|test|tests|docs|example|examples|\.git)$/.test(entry.name))) continue;
      dirBytes(full, onlyScripts, seen);
    } else if (entry.isFile()) {
      if (onlyScripts && (!/\.(c|m)?js$/.test(entry.name) || /\.(map|d\.ts)$/.test(entry.name))) continue;
      try {
        seen.bytes += fs.statSync(full).size;
      } catch {}
    }
  }
  return seen.bytes;
}

// Every installed copy: node_modules/<name> and one level of nesting (node_modules/<pkg>/node_modules/<name>).
function installedCopies(repoRoot) {
  const copies = new Map();
  const add = (name, dir) => {
    const version = readJson(path.join(dir, 'package.json'))?.version;
    if (!version) return;
    if (!copies.has(name)) copies.set(name, []);
    copies.get(name).push({ version, path: path.relative(repoRoot, dir) });
  };
  const packagesIn = dir => {
    const found = [];
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {}
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name.startsWith('.')) continue;
      if (entry.name.startsWith('@')) {
        for (const scoped of fs.readdirSync(path.join(dir, entry.name))) {
          found.push({ name: `${entry.name}/${scoped}`, dir: path.join(dir, entry.name, scoped) });
        }
      } else found.push({ name: entry.name, dir: path.join(dir, entry.name) });
    }
    return found;
  };
  for (const top of packagesIn(path.join(repoRoot, 'node_modules'))) {
    add(top.name, top.dir);
    for (const nested of packagesIn(path.join(top.dir, 'node_modules'))) add(nested.name, nested.dir);
  }
  return copies;
}

// `.../node_modules/@scope/name/lib/x.js` -> { name: '@scope/name', root: '.../node_modules/@scope/name' }
function packageOfModule(id) {
  const clean = id.split(' + ')[0].replace(/\\/g, '/');
  const index = clean.lastIndexOf('node_modules/');
  if (index === -1) return null;
  const rest = clean.slice(index + 'node_modules/'.length).split('/');
  const name = rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
  return { name, root: clean.slice(0, index + 'node_modules/'.length) + name };
}

function fromStats(ctx) {
  const totals = new Map();
  let allBytes = 0;
  for (const chunk of ctx.stats.chunks ?? []) {
    for (const module of chunk.modules ?? []) {
      allBytes += module.bytes ?? 0;
      const owner = packageOfModule(module.id ?? '');
      if (!owner) continue;
      const entry = totals.get(owner.name) ?? { bytes: 0, roots: new Map() };
      entry.bytes += module.bytes ?? 0;
      entry.roots.set(owner.root, (entry.roots.get(owner.root) ?? 0) + (module.bytes ?? 0));
      totals.set(owner.name, entry);
    }
  }
  const duplicates = [];
  for (const [name, entry] of totals) {
    if (entry.roots.size < 2) continue;
    duplicates.push({
      name,
      versions: [...entry.roots].map(([root, bytes]) => {
        const absolute = path.isAbsolute(root) ? root : path.resolve(ctx.repoRoot, root);
        return { version: readJson(path.join(absolute, 'package.json'))?.version ?? null, kb: kb(bytes), path: path.relative(ctx.repoRoot, absolute) };
      })
    });
  }
  const heavy = [...totals]
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .slice(0, 15)
    .map(([name, entry]) => ({
      name,
      kb: kb(entry.bytes),
      share: allBytes ? Math.round((entry.bytes / allBytes) * 1000) / 10 : null,
      note: REPLACEABLE[name] ?? null
    }));
  return { duplicates: duplicates.sort((a, b) => b.versions.length - a.versions.length || a.name.localeCompare(b.name)), heavy };
}

function fromDisk(ctx, pkg, lock) {
  const direct = new Set(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }));
  const copies = installedCopies(ctx.repoRoot);
  const sizes = new Map();
  const sizeOf = relative => {
    if (!sizes.has(relative)) sizes.set(relative, dirBytes(path.join(ctx.repoRoot, relative), false));
    return sizes.get(relative);
  };
  const duplicates = [];
  const lockVersions = new Map();
  for (const entry of lock?.entries ?? []) {
    if (!lockVersions.has(entry.name)) lockVersions.set(entry.name, new Set());
    lockVersions.get(entry.name).add(entry.version);
  }
  for (const [name, versionSet] of lockVersions) {
    if (versionSet.size < 2) continue;
    const onDisk = copies.get(name) ?? [];
    const versions = [...versionSet].sort(compareVersions).map(version => {
      const copy = onDisk.find(item => item.version === version);
      return { version, kb: copy ? kb(sizeOf(copy.path)) : null, path: copy?.path ?? null };
    });
    const biggest = Math.max(0, ...versions.map(item => item.kb ?? 0));
    if (direct.has(name) || biggest >= 50) duplicates.push({ name, versions });
  }
  const measured = Object.keys(pkg.dependencies ?? {})
    .map(name => ({ name, bytes: dirBytes(path.join(ctx.repoRoot, 'node_modules', name), true) }))
    .filter(item => item.bytes > 0);
  const total = measured.reduce((sum, item) => sum + item.bytes, 0);
  const heavy = measured
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 15)
    .map(item => ({
      name: item.name,
      kb: kb(item.bytes),
      share: total ? Math.round((item.bytes / total) * 1000) / 10 : null,
      note: [REPLACEABLE[item.name], 'on-disk size, not bundle size'].filter(Boolean).join('; ')
    }));
  const largest = version => Math.max(0, ...version.versions.map(item => item.kb ?? 0));
  return { duplicates: duplicates.sort((a, b) => largest(b) - largest(a)), heavy };
}

export async function runDependencies(ctx) {
  const pkg = readJson(path.join(ctx.repoRoot, 'package.json'));
  if (!pkg) throw new Error('package.json not found');
  const skipped = [];
  const lock = readLockfile(ctx.repoRoot);
  const [outdated, vulnerabilities] = await Promise.all([
    outdatedSection(ctx, pkg, skipped).catch(error => {
      ctx.errors.push({ section: 'dependencies', file: null, message: `outdated check failed: ${error.message}` });
      return [];
    }),
    vulnerabilitiesSection(ctx, pkg, lock).catch(error => {
      ctx.errors.push({ section: 'dependencies', file: null, message: `vulnerability check failed: ${error.message}` });
      return [];
    })
  ]);
  ctx.progress('Looking for unused, duplicated and heavy packages');
  const unused = unusedSection(ctx, pkg);
  const { duplicates, heavy } = ctx.stats?.chunks ? fromStats(ctx) : fromDisk(ctx, pkg, lock);
  return { outdated, vulnerabilities, unused, duplicates, heavy, skipped };
}
