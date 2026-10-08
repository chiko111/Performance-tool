// Aggregates a recorded session per screen / component / file / thread and compares two sessions.
// Everything that depends on how long a screen was open is normalised to "per second".

import { isNotMemoized } from './compiler-status.mjs';
import { screenPath } from './screen-path.mjs';

const UNKNOWN_SCREEN = '(unknown)';

const round = (value, digits = 1) => {
  const factor = 10 ** digits;
  return Math.round((value ?? 0) * factor) / factor;
};

function bucket(map, key, create) {
  if (!map.has(key)) map.set(key, create());
  return map.get(key);
}

export function summarize(events, meta) {
  const js = events.filter(event => event.type === 'js');
  const native = events.filter(event => event.type === 'native');
  const times = events.map(event => event.receivedAt);
  const durationSec = times.length ? Math.max(1, Math.round((Math.max(...times) - Math.min(...times)) / 1000)) : 0;

  const screens = new Map();
  const newScreen = () => ({
    jsSeconds: 0,
    nativeSeconds: 0,
    commits: 0,
    renderMs: 0,
    longTasks: 0,
    longTaskMs: 0,
    maxBlockMs: 0,
    jsFpsSum: 0,
    gcCount: 0,
    gcCpuMs: 0,
    allocatedMb: 0,
    heapMaxMb: 0,
    cpuMs: 0,
    uiFpsSum: 0,
    uiDrops: 0,
    worstFrameMs: 0,
    memoryMaxMb: 0,
    artGcCount: 0,
    artGcPauseMs: 0,
    batteryMaxC: null,
    cpuMaxC: null,
    thermalMax: null,
    threads: new Map(),
    // Web (perf web): the probe's page numbers and Chrome's (DevTools protocol).
    domNodesMax: null,
    clsSum: 0,
    inpMaxMs: null,
    forcedLayoutMs: 0,
    longFrames: 0,
    scriptMs: 0,
    layoutMs: 0,
    styleMs: 0,
    v8GcCount: 0,
    v8GcMs: 0,
    nodesMax: null,
    listenersMax: null,
    cdpSeconds: 0,
    trackedListenersMax: null,
    leakedMax: null
  });
  const maxOf = (current, value) => (value == null ? current : current == null ? value : Math.max(current, value));
  const thermalReadings = [];

  const components = new Map();
  const files = new Map();
  const slowCommits = [];
  const triggers = new Map();
  const network = new Map();
  const sockets = new Map();
  const socketConnections = new Map();
  const redux = { dispatches: 0, noops: 0, slices: new Map(), actions: new Map() };
  const forcedLayouts = new Map();
  const longFrameScripts = new Map();
  const interactions = [];
  const shiftNodes = new Map();
  let lcp = null;
  let pageLoad = null;
  let lastLeaks = null;

  const addForcedLayout = (entry, screenName, from) => {
    const key = entry.location ?? (String(entry.site ?? '').split('\n')[0] || `${entry.url ?? ''}:${entry.line ?? ''}`);
    const total = bucket(forcedLayouts, key, () => ({ location: entry.location ?? null, fn: entry.fn ?? entry.functionName ?? null, property: entry.property ?? null, component: entry.component ?? null, own: entry.own ?? null, count: 0, ms: 0, maxMs: 0, screens: {}, from }));
    total.count += entry.count ?? 1;
    total.ms += entry.ms ?? 0;
    total.maxMs = Math.max(total.maxMs, entry.maxMs ?? entry.ms ?? 0);
    total.screens[screenName] = (total.screens[screenName] ?? 0) + (entry.ms ?? 0);
  };

  for (const event of js) {
    // A hidden browser tab gets no frames and throttled timers: those seconds would be noise.
    if (event.hidden) continue;
    const screen = bucket(screens, event.screen ?? UNKNOWN_SCREEN, newScreen);
    if (event.web) {
      const web = event.web;
      screen.domNodesMax = maxOf(screen.domNodesMax, web.memory?.domNodes ?? null);
      if (web.memory?.heapMb != null) screen.heapMaxMb = Math.max(screen.heapMaxMb, web.memory.heapMb);
      screen.clsSum += web.vitals?.cls ?? 0;
      for (const interaction of web.vitals?.interactions ?? []) {
        screen.inpMaxMs = maxOf(screen.inpMaxMs, interaction.ms);
        interactions.push({ screen: event.screen ?? UNKNOWN_SCREEN, ...interaction });
      }
      for (const shift of web.vitals?.shifts ?? []) {
        for (const node of shift.nodes ?? []) {
          const total = bucket(shiftNodes, node, () => ({ node, value: 0, count: 0, screen: event.screen ?? UNKNOWN_SCREEN }));
          total.value += shift.value;
          total.count += 1;
        }
      }
      if (web.vitals?.lcp && !lcp) lcp = { screen: event.screen ?? UNKNOWN_SCREEN, ...web.vitals.lcp };
      if (web.vitals?.pageLoad && !pageLoad) pageLoad = web.vitals.pageLoad;
      for (const entry of web.forcedLayouts ?? []) {
        screen.forcedLayoutMs += entry.ms ?? 0;
        addForcedLayout(entry, event.screen ?? UNKNOWN_SCREEN, 'probe');
      }
      for (const frame of web.loafs ?? []) {
        screen.longFrames += 1;
        for (const script of frame.scripts ?? []) {
          const key = script.location ?? `${script.invoker ?? ''} ${script.fn ?? ''}`.trim();
          const total = bucket(longFrameScripts, key, () => ({ location: script.location ?? null, invoker: script.invoker ?? null, fn: script.fn ?? null, own: script.own ?? null, count: 0, ms: 0, forcedLayoutMs: 0, screens: {} }));
          total.count += 1;
          total.ms += script.ms ?? 0;
          total.forcedLayoutMs += script.forcedLayoutMs ?? 0;
          const screenName = event.screen ?? UNKNOWN_SCREEN;
          total.screens[screenName] = (total.screens[screenName] ?? 0) + (script.ms ?? 0);
        }
      }
    }
    if (event.leaks) {
      screen.trackedListenersMax = maxOf(screen.trackedListenersMax, event.leaks.live?.listener ?? null);
      screen.leakedMax = maxOf(screen.leakedMax, event.leaks.leaked ?? null);
      lastLeaks = event.leaks;
    }
    screen.jsSeconds += 1;
    screen.commits += event.commits;
    screen.renderMs += event.commitMs;
    screen.longTasks += event.longTasks;
    screen.longTaskMs += event.longTaskMs;
    screen.maxBlockMs = Math.max(screen.maxBlockMs, event.maxBlockMs);
    screen.jsFpsSum += event.jsFps;
    if (event.hermes) {
      screen.gcCount += event.hermes.gcCount;
      screen.gcCpuMs += event.hermes.gcCpuMs;
      screen.allocatedMb += event.hermes.allocatedMb;
      screen.heapMaxMb = Math.max(screen.heapMaxMb, event.hermes.heapMb);
    }
    for (const entry of event.components) {
      const key = `${entry.screen}\u0000${entry.component}`;
      const total = bucket(components, key, () => ({
        screen: entry.screen,
        component: entry.component,
        file: entry.file,
        selfMs: 0,
        renders: 0,
        mounts: 0,
        libraryMs: 0,
        library: {},
        compiler: null,
        reasons: {}
      }));
      for (const [reason, count] of Object.entries(entry.reasons ?? {})) total.reasons[reason] = (total.reasons[reason] ?? 0) + count;
      total.libraryMs += entry.libraryMs ?? 0;
      for (const [libraryName, ms] of Object.entries(entry.library ?? {})) total.library[libraryName] = (total.library[libraryName] ?? 0) + ms;
      if (entry.compiler && total.compiler?.source !== 'runtime') total.compiler = entry.compiler;
      total.selfMs += entry.selfMs;
      total.renders += entry.renders;
      total.mounts += entry.mounts;
      const fileKey = entry.file ?? (entry.component === '(library)' ? '(library)' : `(library) ${entry.component}`);
      const fileTotal = bucket(files, fileKey, () => ({ file: fileKey, selfMs: 0, renders: 0 }));
      fileTotal.selfMs += entry.selfMs;
      fileTotal.renders += entry.renders;
    }
    for (const commit of event.slowCommits ?? []) slowCommits.push({ screen: event.screen, ...commit });
    for (const trigger of event.triggers ?? []) {
      const total = bucket(triggers, `${trigger.screen}\u0000${trigger.component}`, () => ({ component: trigger.component, screen: trigger.screen, commits: 0, ms: 0 }));
      total.commits += trigger.commits;
      total.ms += trigger.ms;
    }
    for (const request of event.network ?? []) {
      const total = bucket(network, request.key, () => ({ key: request.key, count: 0, ms: 0, maxMs: 0, bytes: 0, errors: 0, duplicates: 0, screens: {} }));
      total.count += request.count;
      total.ms += request.ms;
      total.maxMs = Math.max(total.maxMs, request.maxMs);
      total.bytes += request.bytes;
      total.errors += request.errors;
      total.duplicates += request.duplicates;
      const screenName = event.screen ?? UNKNOWN_SCREEN;
      total.screens[screenName] = (total.screens[screenName] ?? 0) + request.count;
    }
    for (const row of event.sockets ?? []) {
      const total = bucket(sockets, `${row.socket}\u0000${row.topic}`, () => ({ socket: row.socket, topic: row.topic, messages: 0, bytes: 0, sent: 0, sentBytes: 0, commits: 0, renders: 0, renderMs: 0, screens: {} }));
      for (const field of ['messages', 'bytes', 'sent', 'sentBytes', 'commits', 'renders', 'renderMs']) total[field] += row[field] ?? 0;
      const screenName = event.screen ?? UNKNOWN_SCREEN;
      total.screens[screenName] = (total.screens[screenName] ?? 0) + (row.messages ?? 0);
    }
    for (const row of event.socketConnections ?? []) {
      const total = bucket(socketConnections, row.socket, () => ({ socket: row.socket, opens: 0, closes: 0, errors: 0, closeCodes: {} }));
      total.opens += row.opens;
      total.closes += row.closes;
      total.errors += row.errors;
      for (const [code, count] of Object.entries(row.closeCodes ?? {})) total.closeCodes[code] = (total.closeCodes[code] ?? 0) + count;
    }
    if (event.redux) {
      redux.dispatches += event.redux.dispatches;
      redux.noops += event.redux.noops;
      for (const [slice, count] of Object.entries(event.redux.slices ?? {})) {
        bucket(redux.slices, slice, () => ({ slice, updates: 0, commits: 0, renders: 0, renderMs: 0 })).updates += count;
      }
      for (const row of event.redux.sliceRenders ?? []) {
        const total = bucket(redux.slices, row.slice, () => ({ slice: row.slice, updates: 0, commits: 0, renders: 0, renderMs: 0 }));
        total.commits += row.commits;
        total.renders += row.renders;
        total.renderMs += row.renderMs;
      }
      for (const action of event.redux.actions ?? []) {
        const total = bucket(redux.actions, action.type, () => ({ type: action.type, count: 0, ms: 0 }));
        total.count += action.count;
        total.ms += action.ms;
      }
    }
  }

  for (const event of native) {
    const screen = bucket(screens, event.screen ?? UNKNOWN_SCREEN, newScreen);
    screen.nativeSeconds += 1;
    screen.cpuMs += event.cpuMs ?? 0;
    screen.uiFpsSum += event.ui?.fps ?? 0;
    screen.uiDrops += event.ui?.hitches ?? event.ui?.janky ?? 0;
    screen.worstFrameMs = Math.max(screen.worstFrameMs, event.ui?.worstFrameMs ?? event.ui?.p99Ms ?? 0);
    screen.memoryMaxMb = Math.max(screen.memoryMaxMb, event.memoryMb ?? 0);
    screen.artGcCount += event.gc?.artCount ?? 0;
    screen.artGcPauseMs += event.gc?.artPauseMs ?? 0;
    if (event.web) {
      screen.cdpSeconds += 1;
      screen.scriptMs += event.web.scriptMs ?? 0;
      screen.layoutMs += event.web.layoutMs ?? 0;
      screen.styleMs += event.web.styleMs ?? 0;
      screen.nodesMax = maxOf(screen.nodesMax, event.web.nodes ?? null);
      screen.listenersMax = maxOf(screen.listenersMax, event.web.listeners ?? null);
      for (const entry of event.web.forcedLayouts ?? []) addForcedLayout(entry, event.screen ?? UNKNOWN_SCREEN, 'chrome');
    }
    if (event.gc?.v8Count != null) {
      screen.v8GcCount += event.gc.v8Count;
      screen.v8GcMs += event.gc.v8Ms ?? 0;
    }
    if (event.thermal) {
      // Android: status 0 none … 6 shutdown; iOS: thermalState 0 nominal … 3 critical.
      const level = event.thermal.status ?? event.thermal.state ?? null;
      screen.batteryMaxC = maxOf(screen.batteryMaxC, event.thermal.batteryC ?? null);
      screen.cpuMaxC = maxOf(screen.cpuMaxC, event.thermal.cpuC ?? null);
      screen.thermalMax = maxOf(screen.thermalMax, level);
      thermalReadings.push({ batteryC: event.thermal.batteryC ?? null, cpuC: event.thermal.cpuC ?? null, level });
    }
    for (const thread of event.threads ?? []) {
      screen.threads.set(thread.name, (screen.threads.get(thread.name) ?? 0) + thread.cpuMs);
    }
  }

  const allThreads = new Map();
  const screenRows = [...screens.entries()].map(([name, screen]) => {
    for (const [thread, ms] of screen.threads) allThreads.set(thread, (allThreads.get(thread) ?? 0) + ms);
    const jsSeconds = screen.jsSeconds || 1;
    const nativeSeconds = screen.nativeSeconds || 1;
    return {
      screen: name,
      seconds: Math.max(screen.jsSeconds, screen.nativeSeconds),
      renderMsPerSec: round(screen.renderMs / jsSeconds),
      commitsPerSec: round(screen.commits / jsSeconds),
      longTasks: screen.longTasks,
      longTaskMsPerSec: round(screen.longTaskMs / jsSeconds),
      maxBlockMs: round(screen.maxBlockMs, 0),
      jsFps: round(screen.jsFpsSum / jsSeconds, 0),
      hermesGcPerSec: round(screen.gcCount / jsSeconds, 2),
      hermesGcMsPerSec: round(screen.gcCpuMs / jsSeconds),
      allocMbPerSec: round(screen.allocatedMb / jsSeconds, 2),
      heapMaxMb: round(screen.heapMaxMb),
      cpuPct: screen.nativeSeconds ? round(screen.cpuMs / nativeSeconds / 10, 0) : null,
      uiFps: screen.nativeSeconds ? round(screen.uiFpsSum / nativeSeconds, 0) : null,
      uiDrops: screen.uiDrops,
      worstFrameMs: round(screen.worstFrameMs, 0),
      memoryMaxMb: round(screen.memoryMaxMb),
      artGcCount: screen.artGcCount,
      artGcPauseMs: round(screen.artGcPauseMs),
      batteryMaxC: screen.batteryMaxC,
      cpuMaxC: screen.cpuMaxC,
      thermalMax: screen.thermalMax,
      ...(screen.cdpSeconds || screen.domNodesMax != null
        ? {
            scriptMsPerSec: screen.cdpSeconds ? round(screen.scriptMs / screen.cdpSeconds) : null,
            layoutMsPerSec: screen.cdpSeconds ? round(screen.layoutMs / screen.cdpSeconds) : null,
            styleMsPerSec: screen.cdpSeconds ? round(screen.styleMs / screen.cdpSeconds) : null,
            v8GcPerSec: screen.cdpSeconds ? round(screen.v8GcCount / screen.cdpSeconds, 2) : null,
            v8GcMsPerSec: screen.cdpSeconds ? round(screen.v8GcMs / screen.cdpSeconds) : null,
            domNodesMax: screen.nodesMax ?? screen.domNodesMax,
            listenersMax: screen.listenersMax,
            cls: round(screen.clsSum, 3),
            inpMs: screen.inpMaxMs,
            forcedLayoutMsPerSec: round(screen.forcedLayoutMs / jsSeconds),
            longFrames: screen.longFrames
          }
        : {}),
      trackedListenersMax: screen.trackedListenersMax,
      leakedMax: screen.leakedMax,
      topThreads: [...screen.threads.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([thread, ms]) => ({ thread, cpuPct: round(ms / nativeSeconds / 10, 0) }))
    };
  });

  const nativeSeconds = native.length || 1;
  const jsSeconds = js.length || 1;

  return {
    meta: {
      ...meta,
      platform: events.find(event => event.platform)?.platform ?? 'unknown',
      durationSec,
      jsSamples: js.length,
      nativeSamples: native.length,
      build: js.find(event => event.build)?.build ?? null,
      thermal: thermalReadings.length
        ? {
            startC: thermalReadings.find(row => row.batteryC != null)?.batteryC ?? null,
            endC: [...thermalReadings].reverse().find(row => row.batteryC != null)?.batteryC ?? null,
            cpuMaxC: thermalReadings.reduce((max, row) => maxOf(max, row.cpuC), null),
            levelMax: thermalReadings.reduce((max, row) => maxOf(max, row.level), null),
            scale: native.find(event => event.thermal)?.platform === 'ios' ? 'ios' : 'android'
          }
        : null
    },
    screens: screenRows.sort((a, b) => b.seconds - a.seconds),
    crashes: events
      .filter(event => event.type === 'crash')
      .map(({ receivedAt, screen, kind, reason, detail, title, signal, thread, frames, memoryMb, fatal, file }) => ({
        receivedAt, screen, kind, reason, detail, title, signal, thread, frames: frames ?? [], memoryMb, fatal: fatal !== false, file
      })),
    screenPath: screenPath(js.map(event => event.screen)),
    components: [...components.values()]
      .map(entry => ({
        ...entry,
        selfMs: round(entry.selfMs),
        libraryMs: round(entry.libraryMs),
        library: Object.fromEntries(Object.entries(entry.library).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n, ms]) => [n, round(ms)])),
        reasons: Object.fromEntries(Object.entries(entry.reasons).sort((a, b) => b[1] - a[1]).slice(0, 5)),
        msPerSec: round(entry.selfMs / jsSeconds, 2),
        rendersPerSec: round(entry.renders / jsSeconds, 2)
      }))
      .sort((a, b) => b.selfMs - a.selfMs)
      .slice(0, 300),
    files: [...files.values()]
      .map(entry => ({ ...entry, selfMs: round(entry.selfMs), msPerSec: round(entry.selfMs / jsSeconds, 2) }))
      .sort((a, b) => b.selfMs - a.selfMs)
      .slice(0, 150),
    threads: [...allThreads.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([thread, ms]) => ({ thread, cpuMs: round(ms, 0), cpuPct: round(ms / nativeSeconds / 10, 0) })),
    slowCommits: slowCommits.sort((a, b) => b.ms - a.ms).slice(0, 40),
    // Who scheduled the work of the commits (React's profiling build): a commit nothing of ours
    // rendered in, like a frozen screen woken up by a timer, is still traced to its component.
    triggers: [...triggers.values()]
      .map(entry => ({ ...entry, ms: round(entry.ms), commitsPerSec: round(entry.commits / jsSeconds, 2), msPerSec: round(entry.ms / jsSeconds, 2) }))
      .sort((a, b) => b.commits - a.commits)
      .slice(0, 40),
    network: [...network.values()]
      .map(entry => ({
        key: entry.key,
        count: entry.count,
        perSec: round(entry.count / jsSeconds, 2),
        avgMs: round(entry.ms / Math.max(1, entry.count), 0),
        maxMs: entry.maxMs,
        kb: round(entry.bytes / 1024),
        errors: entry.errors,
        duplicates: entry.duplicates,
        topScreen: Object.entries(entry.screens).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 60),
    // STOMP messages per destination (topic); "(messages)" for a socket that does not speak STOMP.
    sockets: [...sockets.values()]
      .map(entry => ({
        key: `${entry.socket} ${entry.topic}`,
        socket: entry.socket,
        topic: entry.topic,
        messages: entry.messages,
        perSec: round(entry.messages / jsSeconds, 2),
        kb: round(entry.bytes / 1024),
        sent: entry.sent,
        sentKb: round(entry.sentBytes / 1024),
        renders: round(entry.renders),
        rendersPerSec: round(entry.renders / jsSeconds, 1),
        renderMs: round(entry.renderMs),
        topScreen: Object.entries(entry.screens).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
      }))
      .sort((a, b) => b.messages - a.messages)
      .slice(0, 60),
    socketConnections: [...socketConnections.values()],
    redux: {
      dispatches: redux.dispatches,
      dispatchesPerSec: round(redux.dispatches / jsSeconds, 2),
      noops: redux.noops,
      noopsPerSec: round(redux.noops / jsSeconds, 2),
      slices: [...redux.slices.values()]
        .map(entry => ({ ...entry, perSec: round(entry.updates / jsSeconds, 2), rendersPerSec: round(entry.renders / jsSeconds, 1), renderMs: round(entry.renderMs) }))
        .sort((a, b) => b.updates - a.updates)
        .slice(0, 40),
      actions: [...redux.actions.values()]
        .map(entry => ({ ...entry, perSec: round(entry.count / jsSeconds, 2) }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 40)
    },
    web: js.some(event => event.web)
      ? {
          lcp,
          pageLoad,
          forcedLayouts: [...forcedLayouts.values()]
            .map(entry => ({ ...entry, ms: round(entry.ms), maxMs: round(entry.maxMs), topScreen: Object.entries(entry.screens).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null, screens: undefined }))
            .sort((a, b) => b.ms - a.ms)
            .slice(0, 30),
          longFrameScripts: [...longFrameScripts.values()]
            .map(entry => ({ ...entry, ms: round(entry.ms), forcedLayoutMs: round(entry.forcedLayoutMs), topScreen: Object.entries(entry.screens).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null, screens: undefined }))
            .sort((a, b) => b.ms - a.ms)
            .slice(0, 30),
          interactions: interactions.sort((a, b) => b.ms - a.ms).slice(0, 20),
          layoutShifts: [...shiftNodes.values()].map(entry => ({ ...entry, value: round(entry.value, 4) })).sort((a, b) => b.value - a.value).slice(0, 15)
        }
      : null,
    leaks: lastLeaks
  };
}

const topReasons = reasons =>
  Object.entries(reasons ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([reason, count]) => `${reason} ×${count}`)
    .join('; ');

function change(before, after) {
  if (before == null || after == null) return null;
  if (before === 0) return after === 0 ? 0 : null;
  return Math.round(((after - before) / before) * 100);
}

export function compareSummaries(before, after) {
  const screenNames = [...new Set([...before.screens, ...after.screens].map(row => row.screen))];
  const metrics = [
    'renderMsPerSec',
    'commitsPerSec',
    'longTaskMsPerSec',
    'maxBlockMs',
    'jsFps',
    'hermesGcPerSec',
    'hermesGcMsPerSec',
    'allocMbPerSec',
    'heapMaxMb',
    'cpuPct',
    'uiFps',
    'uiDrops',
    'worstFrameMs',
    'memoryMaxMb',
    'artGcCount',
    'batteryMaxC',
    'cpuMaxC',
    'thermalMax',
    'scriptMsPerSec',
    'layoutMsPerSec',
    'styleMsPerSec',
    'v8GcMsPerSec',
    'domNodesMax',
    'listenersMax',
    'cls',
    'inpMs',
    'forcedLayoutMsPerSec',
    'longFrames',
    'trackedListenersMax',
    'leakedMax'
  ];
  const screens = screenNames.map(name => {
    const a = before.screens.find(row => row.screen === name);
    const b = after.screens.find(row => row.screen === name);
    return {
      screen: name,
      metrics: metrics.map(metric => ({
        metric,
        before: a?.[metric] ?? null,
        after: b?.[metric] ?? null,
        change: change(a?.[metric], b?.[metric])
      }))
    };
  });

  const key = row => `${row.screen}\u0000${row.component}`;
  const beforeComponents = new Map(before.components.map(row => [key(row), row]));
  const afterComponents = new Map(after.components.map(row => [key(row), row]));
  const componentRows = [...new Set([...beforeComponents.keys(), ...afterComponents.keys()])]
    .map(id => {
      const a = beforeComponents.get(id);
      const b = afterComponents.get(id);
      const row = a ?? b;
      return {
        screen: row.screen,
        component: row.component,
        file: row.file,
        beforeMsPerSec: a?.msPerSec ?? 0,
        afterMsPerSec: b?.msPerSec ?? 0,
        beforeRendersPerSec: a?.rendersPerSec ?? 0,
        afterRendersPerSec: b?.rendersPerSec ?? 0,
        beforeCompiler: a?.compiler?.status ?? null,
        afterCompiler: b?.compiler?.status ?? null,
        compilerReasons: b?.compiler?.reasons ?? a?.compiler?.reasons ?? [],
        compilerLine: b?.compiler?.line ?? a?.compiler?.line ?? null,
        reasons: topReasons(b?.reasons ?? a?.reasons),
        deltaMsPerSec: round((b?.msPerSec ?? 0) - (a?.msPerSec ?? 0), 2)
      };
    })
    .sort((x, y) => Math.abs(y.deltaMsPerSec) - Math.abs(x.deltaMsPerSec));
  const components = componentRows.slice(0, 100);
  // Every rendered component the compiler did not memoize, in either session (not only the top 100).
  const notMemoized = componentRows
    .filter(row => isNotMemoized(row.beforeCompiler) || isNotMemoized(row.afterCompiler))
    .sort((x, y) => Math.max(y.beforeMsPerSec, y.afterMsPerSec) - Math.max(x.beforeMsPerSec, x.afterMsPerSec));

  const threadNames = [...new Set([...before.threads, ...after.threads].map(row => row.thread))];
  const threads = threadNames
    .map(thread => {
      const a = before.threads.find(row => row.thread === thread);
      const b = after.threads.find(row => row.thread === thread);
      return { thread, before: a?.cpuPct ?? 0, after: b?.cpuPct ?? 0, change: change(a?.cpuPct, b?.cpuPct) };
    })
    .sort((x, y) => Math.max(y.before, y.after) - Math.max(x.before, x.after))
    .slice(0, 25);

  // Keyed lists (requests per endpoint, Redux slices and actions) compared per second.
  const pairs = (beforeRows = [], afterRows = [], key, fields) =>
    [...new Set([...beforeRows, ...afterRows].map(row => row[key]))].map(id => {
      const a = beforeRows.find(row => row[key] === id);
      const b = afterRows.find(row => row[key] === id);
      return Object.fromEntries([[key, id], ...fields.flatMap(field => [[`before_${field}`, a?.[field] ?? 0], [`after_${field}`, b?.[field] ?? 0]])]);
    });
  const network = pairs(before.network, after.network, 'key', ['perSec', 'avgMs', 'kb', 'duplicates', 'errors'])
    .sort((x, y) => Math.max(y.before_perSec, y.after_perSec) - Math.max(x.before_perSec, x.after_perSec))
    .slice(0, 40);
  const sockets = pairs(before.sockets, after.sockets, 'key', ['perSec', 'kb', 'rendersPerSec'])
    .sort((x, y) => Math.max(y.before_perSec, y.after_perSec) - Math.max(x.before_perSec, x.after_perSec))
    .slice(0, 40);
  const slices = pairs(before.redux?.slices, after.redux?.slices, 'slice', ['perSec', 'rendersPerSec', 'renderMs'])
    .sort((x, y) => Math.max(y.before_rendersPerSec, y.after_rendersPerSec) - Math.max(x.before_rendersPerSec, x.after_rendersPerSec))
    .slice(0, 30);
  const actions = pairs(before.redux?.actions, after.redux?.actions, 'type', ['perSec'])
    .sort((x, y) => Math.max(y.before_perSec, y.after_perSec) - Math.max(x.before_perSec, x.after_perSec))
    .slice(0, 30);
  const store = {
    dispatchesPerSec: { before: before.redux?.dispatchesPerSec ?? null, after: after.redux?.dispatchesPerSec ?? null },
    noopsPerSec: { before: before.redux?.noopsPerSec ?? null, after: after.redux?.noopsPerSec ?? null }
  };

  return { before: before.meta, after: after.meta, screens, components, notMemoized, threads, network, sockets, slices, actions, store };
}
