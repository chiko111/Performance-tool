/* eslint-disable no-undef, @typescript-eslint/no-var-requires */
// Live performance probe. Bundled ONLY by `perf ios|android` (~/perf-tool), which points the
// bundler at a generated entry file outside the project. Never part of a normal or store build.
//
// It must be evaluated before React: it installs a minimal React DevTools hook so the
// profiling renderer (aliased in metro.config.js) reports every commit with per-fiber timings.

const hosts = require('./hosts.json');
const build = require('./build.json');
const ownComponents = new Set(require('./components.json'));

const PORT = 8099;
const FLUSH_MS = 1000;
const LAG_INTERVAL_MS = 50;
const LONG_TASK_MS = 50;
const MAX_BUFFERED = 120;

const COMPONENT_TAGS = new Set([0, 1, 11, 14, 15]); // Function, Class, ForwardRef, Memo, SimpleMemo
const PERFORMED_WORK = 1;

let started = false;
// Distinguishes app launches so the server never mixes counters of two processes.
const sessionId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
let endpoint = null;
let current = createWindow();
const pending = [];

function createWindow() {
  return {
    components: new Map(),
    screens: new Map(),
    commits: 0,
    commitMs: 0,
    slowCommits: [],
    triggers: new Map(),
    jsFrames: 0,
    longTasks: 0,
    longTaskMs: 0,
    maxBlockMs: 0,
    network: new Map(),
    actions: new Map(),
    store: { dispatches: 0, noops: 0, slices: new Map() }
  };
}

// ---------- Why a component rendered ----------
// Compares the rendered fiber with its previous version: changed props (names), a state hook, a
// useSelector / useSyncExternalStore snapshot, or a context value. Nothing changed means the
// parent rendered and this component is not memoized against it.

const CONTEXT_PROVIDER_TAG = 10;
const contextOwners = new WeakMap(); // context object -> component that renders its provider

function contextName(context) {
  return context.displayName || contextOwners.get(context) || 'Context';
}

function renderReasons(fiber) {
  const previous = fiber.alternate;
  const reasons = [];
  let hook = fiber.memoizedState;
  let previousHook = previous.memoizedState;
  while (hook && previousHook && typeof hook === 'object' && 'next' in hook) {
    if (hook.queue && !Object.is(hook.memoizedState, previousHook.memoizedState)) {
      reasons.push(hook.queue.getSnapshot ? 'store (useSelector)' : 'state');
    }
    hook = hook.next;
    previousHook = previousHook.next;
  }
  let dependency = fiber.dependencies && fiber.dependencies.firstContext;
  let previousDependency = previous.dependencies && previous.dependencies.firstContext;
  while (dependency && previousDependency) {
    if (!Object.is(dependency.memoizedValue, previousDependency.memoizedValue)) {
      reasons.push(`context: ${contextName(dependency.context)}`);
    }
    dependency = dependency.next;
    previousDependency = previousDependency.next;
  }
  const props = fiber.memoizedProps;
  const previousProps = previous.memoizedProps;
  if (props !== previousProps && props && previousProps && typeof props === 'object') {
    const changed = Object.keys(props).filter(key => !Object.is(props[key], previousProps[key]));
    for (const key of Object.keys(previousProps)) if (!(key in props)) changed.push(key);
    if (changed.length) reasons.push(`props: ${changed.slice(0, 4).join(', ')}${changed.length > 4 ? '…' : ''}`);
  }
  if (!reasons.length) reasons.push('parent rendered (props equal)');
  return [...new Set(reasons)];
}

// ---------- Redux ----------
// The store is found on <Provider store> during the first commit. Every dispatch, also the ones
// from thunks, notifies subscribers: the probe compares the new state with the old one by
// reference to see which slices changed. Action types come from store.dispatch (thunks show as
// "(thunk)"; actions they dispatch internally are only visible as slice changes).

let reduxStore = null;
let lastStoreUpdateAt = 0;
let slicesSinceCommit = new Set();

function changedSlices(previous, next) {
  const paths = [];
  if (!previous || !next || typeof next !== 'object') return paths;
  for (const key of Object.keys(next)) {
    if (Object.is(previous[key], next[key])) continue;
    const before = previous[key];
    const after = next[key];
    const inner =
      before && after && typeof after === 'object' && !Array.isArray(after)
        ? Object.keys(after).filter(subKey => !Object.is(before[subKey], after[subKey]))
        : [];
    if (inner.length && inner.length <= 6) inner.forEach(subKey => paths.push(`${key}.${subKey}`));
    else paths.push(key);
  }
  return paths;
}

function attachStore(store) {
  if (reduxStore || !store || typeof store.subscribe !== 'function' || typeof store.getState !== 'function') return;
  reduxStore = store;
  let previous = store.getState();
  store.subscribe(() => {
    const next = store.getState();
    current.store.dispatches += 1;
    if (next === previous) {
      current.store.noops += 1;
      return;
    }
    for (const path of changedSlices(previous, next)) {
      current.store.slices.set(path, (current.store.slices.get(path) || 0) + 1);
      slicesSinceCommit.add(path);
    }
    previous = next;
    lastStoreUpdateAt = Date.now();
  });
  const dispatch = store.dispatch;
  store.dispatch = function (action, ...rest) {
    const type = typeof action === 'function' ? '(thunk)' : String((action && action.type) || '(unknown)');
    const entry = current.actions.get(type) || { type, count: 0, ms: 0 };
    const startedAt = Date.now();
    try {
      return dispatch.call(this, action, ...rest);
    } finally {
      entry.count += 1;
      entry.ms += Date.now() - startedAt;
      current.actions.set(type, entry);
    }
  };
}

// ---------- Network ----------
// Every XMLHttpRequest (fetch and axios use it in React Native) is counted per endpoint. Ids in
// the path and query values are folded so the same endpoint groups together. A duplicate is the
// exact same request (method + full URL) while it is in flight or less than a second after it
// finished; the same endpoint with other parameters (another section's filterId) is not.

const DUPLICATE_WINDOW_MS = 1000;
const inFlight = new Map();
const lastFinished = new Map();

function endpointKey(method, url) {
  const match = String(url).match(/^(?:https?:\/\/)?([^/?#]*)([^?#]*)(?:\?([^#]*))?/);
  if (!match) return `${method} ${url}`;
  const [, host, pathname, query] = match;
  const path = pathname
    .split('/')
    .map(part => (/^\d+$|^[0-9a-f-]{16,}$|^[0-9a-f]{24}$/i.test(part) ? ':id' : part))
    .join('/');
  const params = query ? `?${query.split('&').map(pair => pair.split('=')[0]).sort().join('&')}` : '';
  return `${method.toUpperCase()} ${host}${path}${params}`;
}

function installNetworkHook() {
  const Request = global.XMLHttpRequest;
  if (!Request || Request.prototype.__perfProbe) return;
  Request.prototype.__perfProbe = true;
  const open = Request.prototype.open;
  const send = Request.prototype.send;
  Request.prototype.open = function (method, url, ...rest) {
    this.__perfRequest = { method: method || 'GET', url: String(url) };
    return open.call(this, method, url, ...rest);
  };
  Request.prototype.send = function (...args) {
    const request = this.__perfRequest;
    if (request && !request.url.includes(`:${PORT}/`)) {
      const key = endpointKey(request.method, request.url);
      const exact = `${request.method.toUpperCase()} ${request.url}`;
      const startedAt = Date.now();
      const duplicate = (inFlight.get(exact) || 0) > 0 || startedAt - (lastFinished.get(exact) || 0) < DUPLICATE_WINDOW_MS;
      inFlight.set(exact, (inFlight.get(exact) || 0) + 1);
      this.addEventListener('loadend', () => {
        const ms = Date.now() - startedAt;
        inFlight.set(exact, Math.max(0, (inFlight.get(exact) || 1) - 1));
        lastFinished.set(exact, Date.now());
        let bytes = 0;
        try {
          bytes = Number(this.getResponseHeader('content-length')) || (typeof this.responseText === 'string' ? this.responseText.length : 0);
        } catch {
          bytes = 0;
        }
        const entry = current.network.get(key) || { key, count: 0, ms: 0, maxMs: 0, bytes: 0, errors: 0, duplicates: 0 };
        entry.count += 1;
        entry.ms += ms;
        entry.maxMs = Math.max(entry.maxMs, ms);
        entry.bytes += bytes;
        if (!this.status || this.status >= 400) entry.errors += 1;
        if (duplicate) entry.duplicates += 1;
        current.network.set(key, entry);
      });
    }
    return send.apply(this, args);
  };
}

// React's own fibers have no component name; labelled so their time shows up in the breakdown.
const REACT_FIBER_NAMES = {
  4: 'Portal',
  7: 'Fragment',
  8: 'Mode',
  9: 'Context.Consumer',
  10: 'Context.Provider',
  12: 'Profiler',
  13: 'Suspense',
  19: 'SuspenseList',
  22: 'Offscreen',
  31: 'Activity'
};

function fiberLabel(fiber) {
  return componentName(fiber) || REACT_FIBER_NAMES[fiber.tag] || null;
}

function componentName(fiber) {
  const type = fiber.type;
  if (!type) return null;
  if (typeof type === 'function') return type.displayName || type.name || 'Anonymous';
  if (typeof type === 'object') {
    if (type.displayName) return type.displayName;
    const inner = type.render || type.type;
    if (inner) return inner.displayName || inner.name || 'Anonymous';
  }
  return null;
}

// The component that scheduled an update, named like the rest of the report: the closest one of
// ours at or above it (a library hook's state belongs to the component using it), and its screen.
function describeUpdater(fiber) {
  let name = null;
  let screen = null;
  for (let node = fiber; node; node = node.return) {
    const nodeName = COMPONENT_TAGS.has(node.tag) ? componentName(node) : null;
    if (!name && nodeName && ownComponents.has(nodeName)) name = nodeName;
    const props = node.memoizedProps;
    if (!screen && props && props.route && typeof props.route.name === 'string' && props.navigation) screen = props.route.name;
    if (name && screen) break;
  }
  return { component: name || componentName(fiber) || '(library)', screen: screen || '(root)' };
}

// React's profiling build keeps the fibers that scheduled the work of a commit
// (root.memoizedUpdaters, what React DevTools shows as "what caused this update"). A commit no
// component of ours rendered in, e.g. a frozen screen woken up again and again, still has them.
function recordTriggers(root, commitMs) {
  const updaters = root.memoizedUpdaters;
  if (!updaters || !updaters.size) return;
  for (const fiber of updaters) {
    const { component, screen } = describeUpdater(fiber);
    const key = screen + '\u0000' + component;
    const entry = current.triggers.get(key) || { component, screen, commits: 0, ms: 0 };
    entry.commits += 1;
    entry.ms += commitMs / updaters.size;
    current.triggers.set(key, entry);
  }
}

function screenName(fiber, inherited) {
  const props = fiber.memoizedProps;
  const route = props && props.route;
  if (route && typeof route.name === 'string' && props.navigation) return route.name;
  return inherited;
}

// Mirrors React's own logComponentRender: children are re-walked only when they were
// re-created in this commit, otherwise their actualDuration is stale from a previous commit.
function onCommit(root) {
  const rootFiber = root.current;
  if (!rootFiber) return;
  const commitMs = rootFiber.actualDuration || 0;
  // React stamps actualStartTime when it begins a fiber in a render; a fiber it did not process in
  // this render keeps an older stamp together with that older render's actualDuration.
  const renderStartTime = rootFiber.actualStartTime;
  const wasProcessed = fiber => !(renderStartTime >= 0) || fiber.actualStartTime >= renderStartTime;
  current.commits += 1;
  current.commitMs += commitMs;
  try {
    recordTriggers(root, commitMs);
  } catch {
    current.probeErrors = (current.probeErrors || 0) + 1;
  }

  const commitComponents = new Map();
  let commitRenders = 0;
  const stack = [{ fiber: rootFiber, screen: '(root)', owner: null }];
  while (stack.length) {
    const { fiber, screen: parentScreen, owner: parentOwner } = stack.pop();
    if (!wasProcessed(fiber)) continue;
    const screen = screenName(fiber, parentScreen);
    const isComponent = COMPONENT_TAGS.has(fiber.tag);
    const name = isComponent ? componentName(fiber) : null;
    const isOwn = name !== null && ownComponents.has(name);
    const performedWork = isComponent && (fiber.flags & PERFORMED_WORK) === PERFORMED_WORK;
    // Time belongs to the closest of our components that rendered in this commit. One that bailed
    // out (memo) did no work: library and React fibers under it (frozen screens' Suspense/Offscreen,
    // navigators) were charged to it before, so an idle provider looked like the most expensive one.
    const ownsTime = isOwn && performedWork;
    const label = fiberLabel(fiber);
    if (fiber.tag === CONTEXT_PROVIDER_TAG && fiber.type) {
      const context = fiber.type._context || fiber.type;
      if (!contextOwners.has(context) && parentOwner) contextOwners.set(context, parentOwner);
    }
    if (!reduxStore && fiber.memoizedProps && fiber.memoizedProps.store) attachStore(fiber.memoizedProps.store);
    // Time is charged to the closest component defined in our sources; library-only subtrees
    // (navigation containers, providers) keep their own name.
    // Without a rendered component of ours above, library and React fibers share one row per
    // screen; the breakdown keeps their names.
    const owner = ownsTime ? name : parentOwner || '(library)';
    const descend =
      fiber.actualDuration !== 0 && (fiber.alternate === null || fiber.alternate.child !== fiber.child);

    let selfMs = 0;
    if (descend) {
      selfMs = fiber.actualDuration;
      for (let child = fiber.child; child !== null; child = child.sibling) {
        selfMs -= child.actualDuration;
        stack.push({ fiber: child, screen, owner: ownsTime ? name : parentOwner });
      }
    }

    const rendered = (isOwn || !parentOwner) && performedWork;
    if (selfMs <= 0 && !rendered) continue;

    const key = screen + '\u0000' + owner;
    let entry = current.components.get(key);
    if (!entry) {
      entry = { screen, component: owner, selfMs: 0, libraryMs: 0, library: {}, renders: 0, mounts: 0, compiled: false, reasons: {} };
      current.components.set(key, entry);
    }
    if (selfMs > 0) {
      entry.selfMs += selfMs;
      if (label && label !== owner) {
        entry.libraryMs += selfMs;
        entry.library[label] = (entry.library[label] || 0) + selfMs;
      }
    }
    if (rendered) {
      // React Compiler output keeps its cache in useMemoCache, stored on the fiber's updateQueue.
      if (fiber.updateQueue && fiber.updateQueue.memoCache) entry.compiled = true;
      entry.renders += 1;
      commitRenders += 1;
      if (fiber.alternate === null) entry.mounts += 1;
      else if (isOwn) for (const reason of renderReasons(fiber)) entry.reasons[reason] = (entry.reasons[reason] || 0) + 1;
    }
    if (selfMs > 0) {
      current.screens.set(screen, (current.screens.get(screen) || 0) + selfMs);
      commitComponents.set(owner, (commitComponents.get(owner) || 0) + selfMs);
    }
  }

  // A commit right after a store update is charged to the slices that changed.
  if (slicesSinceCommit.size) {
    if (Date.now() - lastStoreUpdateAt < 100 + commitMs) {
      for (const path of slicesSinceCommit) {
        const key = `slice:${path}`;
        const entry = current.actions.get(key) || { type: key, count: 0, ms: 0, commits: 0, renders: 0, renderMs: 0 };
        entry.commits = (entry.commits || 0) + 1;
        entry.renders = (entry.renders || 0) + commitRenders / slicesSinceCommit.size;
        entry.renderMs = (entry.renderMs || 0) + commitMs / slicesSinceCommit.size;
        current.actions.set(key, entry);
      }
    }
    slicesSinceCommit = new Set();
  }

  if (commitMs >= 16) {
    current.slowCommits.push({
      ms: round(commitMs),
      top: [...commitComponents.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([component, ms]) => ({ component, ms: round(ms) }))
    });
  }
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function installHook() {
  const existing = global.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (existing) {
    const original = existing.onCommitFiberRoot;
    existing.onCommitFiberRoot = function (...args) {
      safeCommit(args[1]);
      return original && original.apply(this, args);
    };
    return;
  }
  let nextRendererId = 0;
  global.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    isDisabled: false,
    renderers: new Map(),
    inject(renderer) {
      nextRendererId += 1;
      this.renderers.set(nextRendererId, renderer);
      setTimeout(start, 0);
      return nextRendererId;
    },
    onCommitFiberRoot(_rendererId, root) {
      safeCommit(root);
    },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    checkDCE() {}
  };
}

function safeCommit(root) {
  try {
    onCommit(root);
  } catch (error) {
    current.probeErrors = (current.probeErrors || 0) + 1;
  }
}

// Set by the generated entry file when the project exposes a navigation container ref.
function currentRoute() {
  try {
    const navigationRef = global.__perfProbeNavigationRef?.();
    return navigationRef?.isReady() ? navigationRef.getCurrentRoute()?.name ?? null : null;
  } catch {
    return null;
  }
}

// Focused route of every nested navigator, outermost first, e.g. [Root, Home] — the start point
// of a captured scenario, which a replay navigates back to.
function currentRoutePath() {
  try {
    const navigationRef = global.__perfProbeNavigationRef?.();
    if (!navigationRef?.isReady()) return null;
    const path = [];
    let state = navigationRef.getRootState();
    while (state?.routes) {
      const route = state.routes[state.index ?? state.routes.length - 1];
      let params;
      try {
        params = route.params ? JSON.parse(JSON.stringify(route.params)) : undefined;
      } catch {
        params = undefined; // not serialisable: navigate without them
      }
      path.push({ name: route.name, params });
      state = route.state;
    }
    return path;
  } catch {
    return null;
  }
}

// [Root, Home] → navigate('Root', { screen: 'Home', params }) at any depth.
function navigateTo(path) {
  const navigationRef = global.__perfProbeNavigationRef?.();
  if (!navigationRef?.isReady() || !path?.length) return;
  const nest = ([route, ...rest]) =>
    rest.length ? { ...(route.params || {}), screen: rest[0].name, params: nest(rest) } : route.params;
  navigationRef.navigate(path[0].name, nest(path));
}

function hermesStats() {
  try {
    return global.HermesInternal?.getInstrumentedStats?.() ?? null;
  } catch {
    return null;
  }
}

function snapshot() {
  const window = current;
  current = createWindow();
  return {
    t: Date.now(),
    screen: currentRoute(),
    routePath: currentRoutePath(),
    commits: window.commits,
    commitMs: round(window.commitMs),
    slowCommits: window.slowCommits.slice(0, 10),
    triggers: [...window.triggers.values()]
      .sort((a, b) => b.commits - a.commits)
      .slice(0, 20)
      .map(entry => ({ ...entry, ms: round(entry.ms) })),
    jsFps: window.jsFrames,
    longTasks: window.longTasks,
    longTaskMs: round(window.longTaskMs),
    maxBlockMs: round(window.maxBlockMs),
    screens: Object.fromEntries([...window.screens.entries()].map(([name, ms]) => [name, round(ms)])),
    components: [...window.components.values()]
      .sort((a, b) => b.selfMs - a.selfMs)
      .slice(0, 80)
      .map(entry => ({
        ...entry,
        selfMs: round(entry.selfMs),
        libraryMs: round(entry.libraryMs),
        library: Object.fromEntries(
          Object.entries(entry.library)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 4)
            .map(([libraryName, ms]) => [libraryName, round(ms)])
        )
      })),
    hermes: hermesStats(),
    network: [...window.network.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 40)
      .map(entry => ({ ...entry, ms: round(entry.ms) })),
    redux: {
      dispatches: window.store.dispatches,
      noops: window.store.noops,
      slices: Object.fromEntries(window.store.slices),
      actions: [...window.actions.values()]
        .filter(entry => !entry.type.startsWith('slice:'))
        .map(entry => ({ type: entry.type, count: entry.count, ms: round(entry.ms) })),
      sliceRenders: [...window.actions.values()]
        .filter(entry => entry.type.startsWith('slice:'))
        .map(entry => ({ slice: entry.type.slice(6), commits: entry.commits, renders: round(entry.renders), renderMs: round(entry.renderMs) }))
    },
    probeErrors: window.probeErrors || 0
  };
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function findServer() {
  for (const host of hosts) {
    const url = `http://${host}:${PORT}`;
    try {
      const response = await fetchWithTimeout(`${url}/ping`, {}, 1500);
      if (response.ok) return url;
    } catch {
      // try next host
    }
  }
  return null;
}

async function flush() {
  pending.push(snapshot());
  if (pending.length > MAX_BUFFERED) pending.splice(0, pending.length - MAX_BUFFERED);

  if (!endpoint) {
    endpoint = await findServer();
    if (!endpoint) return;
  }
  const batch = pending.splice(0, pending.length);
  try {
    const response = await fetchWithTimeout(
      `${endpoint}/js`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: require('react-native').Platform.OS, sessionId, build, samples: batch })
      },
      3000
    );
    // The server answers with a command when an automatic run needs the app on a given screen.
    const reply = await response.json().catch(() => null);
    if (reply?.command?.type === 'navigate') navigateTo(reply.command.path);
  } catch {
    pending.unshift(...batch);
    endpoint = null;
  }
}

function start() {
  if (started) return;
  started = true;
  installNetworkHook();

  // Timers and frames run on the display's vsync. An idle screen drops to a low refresh rate (down
  // to 10-24 Hz), and a timer then fires up to a frame late with nothing blocking: that frame is not
  // counted. The shortest frame of the last second is the display's frame time.
  let frameMs = 1000 / 60;
  let shortestFrameMs = Infinity;
  let lastFrameAt = null;
  let frameWindowStart = null;

  let expected = Date.now() + LAG_INTERVAL_MS;
  setInterval(() => {
    const now = Date.now();
    const blocked = Math.max(0, now - expected - frameMs);
    expected = now + LAG_INTERVAL_MS;
    if (blocked > current.maxBlockMs) current.maxBlockMs = blocked;
    if (blocked >= LONG_TASK_MS) {
      current.longTasks += 1;
      current.longTaskMs += blocked;
    }
  }, LAG_INTERVAL_MS);

  const onFrame = time => {
    current.jsFrames += 1;
    if (lastFrameAt !== null) shortestFrameMs = Math.min(shortestFrameMs, time - lastFrameAt);
    lastFrameAt = time;
    frameWindowStart ??= time;
    if (time - frameWindowStart >= 1000 && Number.isFinite(shortestFrameMs)) {
      frameMs = shortestFrameMs;
      shortestFrameMs = Infinity;
      frameWindowStart = time;
    }
    requestAnimationFrame(onFrame);
  };
  requestAnimationFrame(onFrame);

  setInterval(flush, FLUSH_MS);
}

installHook();
