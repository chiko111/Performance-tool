// Circular imports between the project's own files. Only static edges count: a cycle that needs a dynamic
// import() (or a require() inside a function) to close is not an initialisation-order problem.
const MAX_CYCLES = 50;

// graph: Map(file -> [{ to, line }]) of static edges between own files.
function stronglyConnected(graph) {
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const components = [];
  let counter = 0;
  for (const start of graph.keys()) {
    if (index.has(start)) continue;
    // Iterative Tarjan: the import graph of a large app is deep enough to overflow recursion.
    const work = [{ node: start, edge: 0 }];
    index.set(start, counter);
    low.set(start, counter++);
    stack.push(start);
    onStack.add(start);
    while (work.length) {
      const frame = work[work.length - 1];
      const edges = graph.get(frame.node) ?? [];
      if (frame.edge < edges.length) {
        const next = edges[frame.edge++].to;
        if (!index.has(next)) {
          index.set(next, counter);
          low.set(next, counter++);
          stack.push(next);
          onStack.add(next);
          work.push({ node: next, edge: 0 });
        } else if (onStack.has(next)) low.set(frame.node, Math.min(low.get(frame.node), index.get(next)));
        continue;
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1].node;
        low.set(parent, Math.min(low.get(parent), low.get(frame.node)));
      }
      if (low.get(frame.node) === index.get(frame.node)) {
        const component = [];
        let member;
        do {
          member = stack.pop();
          onStack.delete(member);
          component.push(member);
        } while (member !== frame.node);
        if (component.length > 1) components.push(component);
      }
    }
  }
  return components;
}

// Shortest cycle through `start` inside the component (BFS back to start).
function shortestCycleFrom(start, graph, members) {
  const previous = new Map([[start, null]]);
  const queue = [start];
  while (queue.length) {
    const node = queue.shift();
    for (const edge of graph.get(node) ?? []) {
      if (!members.has(edge.to)) continue;
      if (edge.to === start) {
        const path = [node];
        for (let step = previous.get(node); step; step = previous.get(step)) path.unshift(step);
        return path;
      }
      if (!previous.has(edge.to)) {
        previous.set(edge.to, node);
        queue.push(edge.to);
      }
    }
  }
  return null;
}

export function findCycles(graph, relativeOf, barrels) {
  const cycles = [];
  for (const component of stronglyConnected(graph)) {
    const members = new Set(component);
    let best = null;
    // Large components: trying every start is quadratic; 200 starts find the shortest cycle in practice.
    for (const start of component.slice(0, 200)) {
      const cycle = shortestCycleFrom(start, graph, members);
      if (cycle && (!best || cycle.length < best.length)) best = cycle;
      if (best?.length === 2) break;
    }
    if (!best) continue;
    const edges = best.map((from, position) => {
      const to = best[(position + 1) % best.length];
      const edge = (graph.get(from) ?? []).find(item => item.to === to);
      return { from: relativeOf(from), to: relativeOf(to), line: edge?.line ?? null };
    });
    cycles.push({
      files: best.map(relativeOf),
      edges,
      viaBarrel: best.some(file => barrels.has(file)),
      filesInGroup: component.length
    });
  }
  return cycles.sort((a, b) => a.files.length - b.files.length || b.filesInGroup - a.filesInGroup).slice(0, MAX_CYCLES);
}
