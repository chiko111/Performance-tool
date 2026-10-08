// Maps positions in a production bundle back to the project's source files, for the web probe's call
// sites (leaks, forced layouts) and Chrome's long-animation-frame scripts. A small Source Map v3
// reader of its own (perf-tool has no dependencies); maps are fetched from the running app server,
// which also covers webpack-dev-server's in-memory output.
//
//   const mapper = new SourceMapper({ repoRoot, sourceDirs, fetchBase: 'http://127.0.0.1:8080' });
//   mapper.mapFrame('at load (http://192.168.1.5:8080/bundle.1a2b.js:1:20345)')
//     → { file: 'src/screens/Casino/CasinoGrid.tsx', line: 84, column: 12, name: 'load', own: true } | null (not loaded yet)

import path from 'node:path';

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_VALUE = new Map([...BASE64].map((char, index) => [char, index]));
const FETCH_TIMEOUT_MS = 15000;
const MAX_MAPS = 40;

// mappings → per generated line, segments [column, source, line, column, name?] (absolute values).
function decodeMappings(mappings) {
  const lines = [];
  let source = 0;
  let sourceLine = 0;
  let sourceColumn = 0;
  let name = 0;
  let segments = [];
  let column = 0;
  let index = 0;
  const readValue = () => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const digit = BASE64_VALUE.get(mappings[index]);
      index += 1;
      if (digit === undefined) throw new Error('bad source map mappings');
      result += (digit & 31) << shift;
      if (!(digit & 32)) break;
      shift += 5;
    }
    return result & 1 ? -(result >>> 1) : result >>> 1;
  };
  while (index <= mappings.length) {
    const char = mappings[index];
    if (char === ';' || index === mappings.length) {
      lines.push(segments);
      segments = [];
      column = 0;
      index += 1;
      continue;
    }
    if (char === ',') {
      index += 1;
      continue;
    }
    column += readValue();
    const segment = [column];
    if (index < mappings.length && mappings[index] !== ',' && mappings[index] !== ';') {
      source += readValue();
      sourceLine += readValue();
      sourceColumn += readValue();
      segment.push(source, sourceLine, sourceColumn);
      if (index < mappings.length && mappings[index] !== ',' && mappings[index] !== ';') {
        name += readValue();
        segment.push(name);
      }
    }
    segments.push(segment);
  }
  return lines;
}

class SourceMap {
  constructor(map) {
    this.sources = (map.sources ?? []).map(source => `${map.sourceRoot ?? ''}${source}`);
    this.names = map.names ?? [];
    this.lines = decodeMappings(map.mappings ?? '');
  }

  // 1-based line, 0-based column, like stack traces; the closest segment at or before the column.
  lookup(line, column) {
    const segments = this.lines[line - 1];
    if (!segments?.length) return null;
    let low = 0;
    let high = segments.length - 1;
    let found = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (segments[middle][0] <= column) {
        found = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    const segment = segments[Math.max(found, 0)];
    if (segment.length < 4) return null;
    return { source: this.sources[segment[1]], line: segment[2] + 1, column: segment[3], name: segment.length > 4 ? this.names[segment[4]] : null };
  }
}

// "webpack://web-mobile/./src/x.tsx", "webpack:///src/x.tsx", "../../src/x.tsx" → "src/x.tsx" when it
// is inside the project; node_modules paths keep their package path.
function projectPath(source, repoRoot, mapDir) {
  const raw = String(source ?? '');
  const isWebpack = raw.startsWith('webpack://');
  let value = raw.replace(/^webpack:\/\/[^/]*\//, '').replace(/^\.\//, '').replace(/\?.*$/, '');
  if (value.startsWith('file://')) value = value.slice('file://'.length);
  // webpack sources are relative to the project; Rollup's to the map file.
  const base = !isWebpack && mapDir ? mapDir : repoRoot;
  const absolute = path.isAbsolute(value) ? value : path.resolve(base, value);
  const relative = path.relative(repoRoot, absolute);
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) return relative;
  const modules = value.lastIndexOf('node_modules/');
  return modules !== -1 ? value.slice(modules) : value;
}

// V8: "at name (url:1:2)", "at url:1:2", "at async name (url:1:2)"; JavaScriptCore / Firefox: "name@url:1:2".
export function parseFrame(frame) {
  const text = String(frame ?? '').trim();
  let match = text.match(/^at (?:async )?(.*?) \((.+):(\d+):(\d+)\)$/);
  if (match) return { name: match[1], url: match[2], line: Number(match[3]), column: Number(match[4]) - 1 };
  match = text.match(/^at (?:async )?(.+):(\d+):(\d+)$/);
  if (match) return { name: null, url: match[1], line: Number(match[2]), column: Number(match[3]) - 1 };
  match = text.match(/^(.*?)@(.+):(\d+):(\d+)$/);
  if (match) return { name: match[1] || null, url: match[2], line: Number(match[3]), column: Number(match[4]) - 1 };
  return null;
}

export class SourceMapper {
  constructor({ repoRoot, sourceDirs = ['src'], fetchBase = null, outDir = null, log = () => {} }) {
    this.repoRoot = repoRoot;
    this.outDir = outDir;
    this.sourceDirs = sourceDirs.filter(dir => !dir.startsWith('node_modules')).map(dir => dir.replace(/\/$/, ''));
    this.fetchBase = fetchBase;
    this.log = log;
    this.maps = new Map(); // script path → { state: 'loading'|'ready'|'none', map, mapDir, text }
  }

  setTarget({ fetchBase, outDir }) {
    if (fetchBase === this.fetchBase && outDir === this.outDir) return;
    this.fetchBase = fetchBase;
    this.outDir = outDir;
    this.maps.clear();
  }

  isOwn(file) {
    return Boolean(file) && !file.includes('node_modules') && this.sourceDirs.some(dir => dir === '.' || file === dir || file.startsWith(`${dir}/`));
  }

  // The script's path on the app server; frames from phones carry their LAN address, maps are
  // fetched from this Mac.
  scriptPath(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol.startsWith('http') ? parsed.pathname : null;
    } catch {
      return null;
    }
  }

  entry(url) {
    const scriptPath = this.scriptPath(url);
    if (!scriptPath || !this.fetchBase) return null;
    let entry = this.maps.get(scriptPath);
    if (!entry) {
      if (this.maps.size >= MAX_MAPS) this.maps.delete(this.maps.keys().next().value);
      entry = { state: 'loading' };
      this.maps.set(scriptPath, entry);
      this.load(scriptPath, entry).catch(error => {
        entry.state = 'none';
        this.log(`Source map for ${scriptPath}: ${error.message}`);
      });
    }
    return entry;
  }

  async fetchText(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`${response.status} for ${url}`);
      return await response.text();
    } finally {
      clearTimeout(timer);
    }
  }

  async load(scriptPath, entry) {
    const scriptUrl = new URL(scriptPath, this.fetchBase).href;
    const text = await this.fetchText(scriptUrl);
    entry.text = text;
    const reference = text.slice(-4096).match(/\/\/[#@] sourceMappingURL=([^\s'"]+)\s*$/)?.[1];
    if (!reference) {
      entry.state = 'none';
      return;
    }
    const mapUrl = reference.startsWith('data:')
      ? null
      : new URL(reference, scriptUrl).href;
    const raw = reference.startsWith('data:')
      ? Buffer.from(reference.slice(reference.indexOf(',') + 1), reference.includes(';base64,') ? 'base64' : 'utf8').toString('utf8')
      : await this.fetchText(mapUrl);
    const json = JSON.parse(raw);
    if (json.sections) throw new Error('indexed source maps are not supported');
    entry.map = new SourceMap(json);
    // Vite (Rollup) writes sources relative to the map file in the build folder on disk.
    const mapPath = mapUrl ? new URL(mapUrl).pathname : scriptPath;
    entry.mapDir = this.outDir ? path.join(this.outDir, path.dirname(decodeURIComponent(mapPath))) : null;
    entry.state = 'ready';
  }

  // A stack frame → source position; null while its map is loading or when it cannot be mapped.
  mapFrame(frame) {
    const parsed = parseFrame(frame);
    if (!parsed) return null;
    return this.mapPosition(parsed.url, parsed.line, parsed.column, parsed.name);
  }

  mapPosition(url, line, column, name = null) {
    const entry = this.entry(url);
    if (!entry || entry.state !== 'ready') return null;
    const position = entry.map.lookup(line, column);
    if (!position) return null;
    const file = projectPath(position.source, this.repoRoot, entry.mapDir);
    return { file, line: position.line, column: position.column, name: position.name ?? name, own: this.isOwn(file) };
  }

  // Long-animation-frame scripts give a character offset into the script instead of line:column.
  mapCharPosition(url, offset, name = null) {
    const entry = this.entry(url);
    if (!entry || entry.state !== 'ready' || typeof offset !== 'number' || offset < 0) return null;
    const before = entry.text.slice(0, offset);
    const line = before.split('\n').length;
    const column = offset - (before.lastIndexOf('\n') + 1);
    return this.mapPosition(url, line, column, name);
  }

  // The first frame of a stack that is in the project's own sources (else the first mapped frame).
  mapSite(site) {
    if (!site) return null;
    let first = null;
    for (const frame of String(site).split('\n')) {
      const mapped = this.mapFrame(frame);
      if (!mapped) continue;
      if (mapped.own) return mapped;
      first = first ?? mapped;
    }
    return first;
  }
}

export const formatPosition = position => (position ? `${position.file}:${position.line}` : null);
