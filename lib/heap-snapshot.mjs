// V8 heap snapshot parsing for leak hunting: per-constructor counts and detached DOM with a
// retaining path. Real app snapshots have 1-3 million nodes and 100-400 MB of JSON, so the parser
// is incremental: it consumes HeapProfiler.addHeapSnapshotChunk text as it arrives and writes the
// numbers straight into typed arrays. JSON.parse of the whole text would need the complete string
// (V8 caps strings at ~512 MB) plus boxed JS arrays several times the snapshot size.

const NUMERIC_SECTIONS = new Set(['nodes', 'edges', 'trace_function_infos', 'samples', 'locations']);

export class SnapshotParser {
  constructor() {
    this.state = 'header'; // header → key → numbers | nested → … → strings
    this.text = ''; // pending text while looking for the header / the next section key
    this.header = null;
    this.section = null;
    this.target = null; // typed array the current numeric section is written to (null = skipped)
    this.index = 0;
    this.value = 0;
    this.inNumber = false;
    this.depth = 0;
    this.stringChunks = [];
    this.bytes = 0;
  }

  push(chunk) {
    this.bytes += chunk.length;
    let position = 0;
    while (position < chunk.length) {
      if (this.state === 'header') position = this.readHeader(chunk, position);
      else if (this.state === 'key') position = this.readKey(chunk, position);
      else if (this.state === 'numbers') position = this.readNumbers(chunk, position);
      else if (this.state === 'nested') position = this.skipNested(chunk, position);
      else {
        // strings is the last section V8 writes; keep the rest and JSON.parse it once at the end.
        this.stringChunks.push(position ? chunk.slice(position) : chunk);
        return;
      }
    }
  }

  readHeader(chunk, position) {
    this.text += position ? chunk.slice(position) : chunk;
    const at = this.text.indexOf('"nodes"');
    if (at === -1) return chunk.length;
    const head = this.text.slice(0, at).replace(/,\s*$/, '') + '}';
    this.header = JSON.parse(head).snapshot;
    const meta = this.header.meta;
    this.nodeFieldCount = meta.node_fields.length;
    this.edgeFieldCount = meta.edge_fields.length;
    // Uint32 is enough: ids, sizes, counts and indexes all stay below 2^32 in V8 snapshots.
    this.nodes = new Uint32Array(this.header.node_count * this.nodeFieldCount);
    this.edges = new Uint32Array(this.header.edge_count * this.edgeFieldCount);
    const rest = this.text.slice(at);
    this.text = '';
    this.state = 'key';
    this.push(rest);
    this.bytes -= rest.length;
    return chunk.length;
  }

  // Between sections: wait for `"name":[` and decide how to consume the array.
  readKey(chunk, position) {
    const end = chunk.indexOf('[', position);
    if (end === -1) {
      this.text += chunk.slice(position);
      return chunk.length;
    }
    const keyText = this.text + chunk.slice(position, end);
    this.text = '';
    const name = keyText.match(/"(\w+)"\s*:\s*$/)?.[1];
    this.section = name;
    if (name === 'strings') {
      this.state = 'strings';
      this.stringChunks.push(chunk.slice(end));
      return chunk.length;
    }
    if (NUMERIC_SECTIONS.has(name)) {
      this.state = 'numbers';
      this.target = name === 'nodes' ? this.nodes : name === 'edges' ? this.edges : null;
      this.index = 0;
      this.value = 0;
      this.inNumber = false;
    } else {
      // trace_tree and unknown sections hold nested number arrays; skip them by depth.
      this.state = 'nested';
      this.depth = 1;
    }
    return end + 1;
  }

  readNumbers(chunk, position) {
    const target = this.target;
    let value = this.value;
    let inNumber = this.inNumber;
    let index = this.index;
    for (let i = position; i < chunk.length; i++) {
      const code = chunk.charCodeAt(i);
      if (code >= 48 && code <= 57) {
        value = value * 10 + (code - 48);
        inNumber = true;
        continue;
      }
      if (inNumber) {
        if (target && index < target.length) target[index] = value;
        index += 1;
        value = 0;
        inNumber = false;
      }
      if (code === 93) {
        // ']' ends the section.
        this.finishNumbers(index);
        return i + 1;
      }
    }
    this.value = value;
    this.inNumber = inNumber;
    this.index = index;
    return chunk.length;
  }

  finishNumbers(count) {
    if (this.section === 'nodes') this.nodeValues = count;
    if (this.section === 'edges') this.edgeValues = count;
    this.state = 'key';
    this.target = null;
  }

  skipNested(chunk, position) {
    for (let i = position; i < chunk.length; i++) {
      const code = chunk.charCodeAt(i);
      if (code === 91) this.depth += 1;
      else if (code === 93 && --this.depth === 0) {
        this.state = 'key';
        return i + 1;
      }
    }
    return chunk.length;
  }

  // Returns the parsed snapshot with reverse edges (retainers) built.
  finish() {
    if (!this.header) throw new Error('Heap snapshot was empty or not in V8 format');
    let tail = this.stringChunks.join('');
    this.stringChunks = [];
    tail = tail.slice(0, tail.lastIndexOf(']') + 1);
    const strings = JSON.parse(tail);
    return new HeapSnapshot(this.header.meta, this.nodes, this.edges, strings);
  }
}

export class HeapSnapshot {
  constructor(meta, nodes, edges, strings) {
    this.strings = strings;
    this.nodes = nodes;
    this.edges = edges;
    const nodeFields = meta.node_fields;
    const edgeFields = meta.edge_fields;
    this.nodeFieldCount = nodeFields.length;
    this.edgeFieldCount = edgeFields.length;
    this.nodeTypeOffset = nodeFields.indexOf('type');
    this.nodeNameOffset = nodeFields.indexOf('name');
    this.nodeSelfSizeOffset = nodeFields.indexOf('self_size');
    this.nodeEdgeCountOffset = nodeFields.indexOf('edge_count');
    this.nodeDetachednessOffset = nodeFields.indexOf('detachedness');
    this.edgeTypeOffset = edgeFields.indexOf('type');
    this.edgeNameOffset = edgeFields.indexOf('name_or_index');
    this.edgeToNodeOffset = edgeFields.indexOf('to_node');
    this.nodeTypes = meta.node_types[this.nodeTypeOffset];
    this.edgeTypes = meta.edge_types[this.edgeTypeOffset];
    this.nodeCount = nodes.length / this.nodeFieldCount;
    this.edgeCount = edges.length / this.edgeFieldCount;
    this.type = name => this.nodeTypes.indexOf(name);
    this.edgeType = name => this.edgeTypes.indexOf(name);
    this.buildEdgeIndex();
  }

  // firstEdge[n] .. firstEdge[n + 1] are node n's outgoing edges (in edge ordinals); retainers are
  // the same edges grouped by target. Typed arrays only: ~12 bytes per edge for millions of edges.
  buildEdgeIndex() {
    const { nodes, edges, nodeCount, edgeCount, nodeFieldCount, edgeFieldCount } = this;
    const firstEdge = new Uint32Array(nodeCount + 1);
    for (let n = 0, e = 0; n < nodeCount; n++) {
      firstEdge[n] = e;
      e += nodes[n * nodeFieldCount + this.nodeEdgeCountOffset];
    }
    firstEdge[nodeCount] = edgeCount;
    const firstRetainer = new Uint32Array(nodeCount + 1);
    for (let e = 0; e < edgeCount; e++) firstRetainer[edges[e * edgeFieldCount + this.edgeToNodeOffset] / nodeFieldCount] += 1;
    // Exclusive prefix sum turns counts into start offsets.
    let sum = 0;
    for (let n = 0; n <= nodeCount; n++) {
      const count = firstRetainer[n];
      firstRetainer[n] = sum;
      sum += count;
    }
    const retainerEdge = new Uint32Array(edgeCount);
    const retainerNode = new Uint32Array(edgeCount);
    const fill = firstRetainer.slice(0, nodeCount);
    for (let n = 0; n < nodeCount; n++) {
      for (let e = firstEdge[n]; e < firstEdge[n + 1]; e++) {
        const to = edges[e * edgeFieldCount + this.edgeToNodeOffset] / nodeFieldCount;
        const slot = fill[to]++;
        retainerEdge[slot] = e;
        retainerNode[slot] = n;
      }
    }
    this.firstEdge = firstEdge;
    this.firstRetainer = firstRetainer;
    this.retainerEdge = retainerEdge;
    this.retainerNode = retainerNode;
  }

  nodeType(n) {
    return this.nodeTypes[this.nodes[n * this.nodeFieldCount + this.nodeTypeOffset]];
  }

  nodeName(n) {
    return this.strings[this.nodes[n * this.nodeFieldCount + this.nodeNameOffset]];
  }

  selfSize(n) {
    return this.nodes[n * this.nodeFieldCount + this.nodeSelfSizeOffset];
  }

  edgeTypeName(e) {
    return this.edgeTypes[this.edges[e * this.edgeFieldCount + this.edgeTypeOffset]];
  }

  edgeName(e) {
    const type = this.edgeTypeName(e);
    const value = this.edges[e * this.edgeFieldCount + this.edgeNameOffset];
    return type === 'element' || type === 'hidden' ? `[${value}]` : String(this.strings[value]);
  }

  // Detached DOM: Blink marks it with detachedness 2 (Chrome ≥ 90); older snapshots only name it.
  // Only native nodes count, so a JS wrapper and its C++ node are not reported twice.
  isDetachedDom(n) {
    if (this.nodeDetachednessOffset !== -1) {
      return this.nodes[n * this.nodeFieldCount + this.nodeDetachednessOffset] === 2 && this.nodeType(n) === 'native';
    }
    return this.nodeName(n).startsWith('Detached ');
  }

  // How a node reads in a retaining path or a constructor list.
  displayName(n) {
    const type = this.nodeType(n);
    const name = this.nodeName(n);
    if (type === 'closure') return `(closure) ${name || '(anonymous)'}`;
    if (type === 'string' || type === 'concatenated string' || type === 'sliced string') return `"${name.slice(0, 40)}"`;
    if (type === 'number') return 'heap number';
    if (type === 'regexp') return `/${name.slice(0, 40)}/`;
    // 'Window / http://localhost:3000', 'Window [JSGlobalObject]': the edge already says enough.
    if (isWindowName(name)) return 'Window';
    if (this.isDetachedDom(n) && !name.startsWith('Detached ')) return `Detached ${name}`;
    return readableName(name) || `(${type})`;
  }

  // GC roots and the DOM trees root are synthetic; a Window (global object) ends a useful path too.
  isPathEnd(n) {
    if (n === 0) return true;
    const type = this.nodeType(n);
    const name = this.nodeName(n);
    if (type === 'synthetic') return true;
    return name === '(Document DOM trees)' || isWindowName(name);
  }
}

const isWindowName = name => name === 'Window' || name.startsWith('Window / ') || name.startsWith('Window [');

// Blink's C++ names carry namespaces and long template arguments, contexts a unique scope id:
// 'blink::HeapVectorBacking<cppgc::internal::BasicMember<…>>' → 'HeapVectorBacking<…>',
// 'system / Context / scope @38289' → 'system / Context'.
function readableName(name) {
  if (name.startsWith('system / Context')) return 'system / Context';
  const angle = name.indexOf('<');
  const base = angle > 0 && !name.startsWith('Detached') ? `${name.slice(0, angle)}<…>` : name;
  return base.replace(/\b(blink|cppgc|v8|internal)::/g, '');
}

// { [name]: { count, selfKb } } over JS objects, closures and native (DOM) objects.
export function constructorCounts(snapshot) {
  const totals = new Map();
  const wanted = new Set(['object', 'closure', 'native'].map(snapshot.type));
  const { nodes, nodeFieldCount, nodeTypeOffset } = snapshot;
  for (let n = 0; n < snapshot.nodeCount; n++) {
    if (!wanted.has(nodes[n * nodeFieldCount + nodeTypeOffset])) continue;
    const name = snapshot.displayName(n);
    const entry = totals.get(name) ?? { count: 0, self: 0 };
    entry.count += 1;
    entry.self += snapshot.selfSize(n);
    totals.set(name, entry);
  }
  const result = {};
  for (const [name, { count, self }] of totals) result[name] = { count, selfKb: Math.round((self / 1024) * 10) / 10 };
  return result;
}

// Detached DOM grouped by element name, biggest groups first, each with one retaining path.
export function detachedDomGroups(snapshot, { limit = 20 } = {}) {
  const groups = new Map();
  let total = 0;
  for (let n = 0; n < snapshot.nodeCount; n++) {
    if (!snapshot.isDetachedDom(n)) continue;
    total += 1;
    const name = snapshot.displayName(n);
    const group = groups.get(name) ?? { name, count: 0, self: 0, sample: n };
    group.count += 1;
    group.self += snapshot.selfSize(n);
    groups.set(name, group);
  }
  const top = [...groups.values()].sort((a, b) => b.count - a.count).slice(0, limit);
  return {
    totalDetached: total,
    groups: top.map(group => ({
      name: group.name,
      count: group.count,
      selfKb: Math.round((group.self / 1024) * 10) / 10,
      retainers: retainingPath(snapshot, group.sample)
    }))
  };
}

const MAX_PATH_STEPS = 12;
const MAX_VISITED = 500000;

// Shortest path from the node up to a GC root / DOM trees root / Window, over non-weak edges.
// The first pass refuses to walk through other detached DOM nodes (sibling/parent chains inside
// a detached tree are noise); when the node is only reachable through its detached parent, the
// second pass allows it so the path still reaches whatever holds the tree.
export function retainingPath(snapshot, start) {
  return shortestRetainingPath(snapshot, start, false) ?? shortestRetainingPath(snapshot, start, true) ?? [];
}

function shortestRetainingPath(snapshot, start, throughDetached) {
  const weak = snapshot.edgeType('weak');
  const { edges, edgeFieldCount, edgeTypeOffset, firstRetainer, retainerEdge, retainerNode } = snapshot;
  // BFS tree over retainers: parent.get(r) is the node r retains on the way back to the start,
  // through edge parentEdge.get(r) (an edge of r).
  const parent = new Map([[start, -1]]);
  const parentEdge = new Map();
  let frontier = [start];
  let fallback = null;
  for (let depth = 0; depth < MAX_PATH_STEPS && frontier.length; depth++) {
    const next = [];
    for (const node of frontier) {
      for (let slot = firstRetainer[node]; slot < firstRetainer[node + 1]; slot++) {
        const edge = retainerEdge[slot];
        if (edges[edge * edgeFieldCount + edgeTypeOffset] === weak) continue;
        const from = retainerNode[slot];
        if (parent.has(from)) continue;
        if (!throughDetached && snapshot.isDetachedDom(from)) continue;
        parent.set(from, node);
        parentEdge.set(from, edge);
        if (snapshot.isPathEnd(from)) return buildPath(snapshot, from, parent, parentEdge);
        next.push(from);
        if (parent.size > MAX_VISITED) break;
      }
    }
    if (next.length) fallback = next[0];
    frontier = next;
  }
  // No root within reach: still show the first MAX_PATH_STEPS steps of a path (better than none).
  return fallback === null ? null : buildPath(snapshot, fallback, parent, parentEdge);
}

// Walks back from the top node to the start and returns the steps in start → root order.
function buildPath(snapshot, top, parent, parentEdge) {
  const steps = [];
  for (let node = top; parent.get(node) !== -1; node = parent.get(node)) {
    steps.push({ edge: snapshot.edgeName(parentEdge.get(node)), node: snapshot.displayName(node) });
  }
  return steps.reverse();
}
