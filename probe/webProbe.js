/* eslint-disable no-undef */
// Live performance probe for React web apps. Served only by `perf web` (as /__perf/probe.js, a classic
// script placed first in <head>), never part of a normal or deployed build.
//
// It must run before React: it installs a minimal React DevTools hook so React DOM's profiling build
// (aliased by the generated webpack / Vite config) reports every commit with per-fiber timings, and it
// wraps the browser APIs the leak tracker follows before any app code runs.
//
// The commit analysis mirrors probe/perfProbe.js (React Native); keep the two in step.

var createLeakTracker = require('./leakTracker').createLeakTracker;

var config = window.__PERF_PROBE_CONFIG__ || {};
var build = config.build || null;
var ownComponents = new Set(config.components || []);

var ENDPOINT = '/__perf';
var FLUSH_MS = 1000;
var LAG_INTERVAL_MS = 50;
var LONG_TASK_MS = 50;
var FORCED_LAYOUT_MS = 1;
var MAX_BUFFERED = 120;

var COMPONENT_TAGS = new Set([0, 1, 11, 14, 15]); // Function, Class, ForwardRef, Memo, SimpleMemo
var PERFORMED_WORK = 1;
var CONTEXT_PROVIDER_TAG = 10;

var started = false;
var sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
var current = createWindow();
var pending = [];
var tracker = createLeakTracker({ ownComponents: ownComponents });
var useEffectWrapping = false;

// The probe's own timers and listeners use the originals, captured before the tracker wraps them, so
// they never show up as the app's resources.
var raw = {
  setInterval: window.setInterval.bind(window),
  setTimeout: window.setTimeout.bind(window),
  clearTimeout: window.clearTimeout.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  addEventListener: EventTarget.prototype.addEventListener
};

function createWindow() {
  return {
    components: new Map(),
    screens: new Map(),
    commits: 0,
    commitMs: 0,
    slowCommits: [],
    frames: 0,
    longTasks: 0,
    longTaskMs: 0,
    maxBlockMs: 0,
    triggers: new Map(),
    network: new Map(),
    sockets: new Map(),
    socketConnections: new Map(),
    actions: new Map(),
    store: { dispatches: 0, noops: 0, slices: new Map() },
    forcedLayouts: new Map(),
    loafs: [],
    shifts: [],
    clsValue: 0,
    interactions: new Map(),
    hiddenMs: 0
  };
}

function round(value) {
  return Math.round(value * 100) / 100;
}

// ---------- Element labels (layout shifts, interactions, LCP) ----------

function elementLabel(element) {
  if (!element || !element.tagName) return null;
  var parts = [];
  var node = element;
  for (var depth = 0; node && node.tagName && depth < 3; depth += 1) {
    var part = node.tagName.toLowerCase();
    if (node.id) part += '#' + node.id;
    var className = typeof node.className === 'string' ? node.className.trim().split(/\s+/)[0] : '';
    if (className) part += '.' + className;
    parts.unshift(part);
    if (node.id) break;
    node = node.parentElement;
  }
  var label = parts.join(' > ');
  return label.length > 120 ? '…' + label.slice(-119) : label;
}

// ---------- Screens (routes) ----------
// A screen is the route pattern React Router rendered ("/casino/:gameId"); without a router, the
// path with ids folded. Patterns seen in commits are remembered per pathname for the samples.

var routeForPath = new Map();

function foldPath(pathname) {
  return (
    pathname
      .split('/')
      .map(function (part) {
        return /^\d+$|^[0-9a-f-]{16,}$|^[0-9a-f]{24}$/i.test(part) ? ':id' : part;
      })
      .join('/') || '/'
  );
}

function locationPath() {
  var hash = location.hash && location.hash.indexOf('#/') === 0 ? location.hash.split('?')[0] : '';
  return location.pathname + hash;
}

function currentScreen() {
  var path = locationPath();
  return routeForPath.get(path) || foldPath(path);
}

function joinPattern(parent, child) {
  if (child.charAt(0) === '/') return child;
  var base = parent && parent !== '/' ? parent.replace(/\/$/, '') : '';
  return (base + '/' + child).replace(/\/+/g, '/');
}

// React Router 6/7 renders <RenderedRoute match routeContext>; React Router 5 <Route computedMatch>.
function routePattern(fiber, inherited) {
  var props = fiber.memoizedProps;
  if (!props || typeof props !== 'object') return inherited;
  var match = props.match;
  if (match && props.routeContext && match.route && typeof match.pathname === 'string') {
    var routePath = match.route.path;
    return typeof routePath === 'string' && routePath ? joinPattern(inherited, routePath) : inherited || '/';
  }
  var computed = props.computedMatch;
  if (computed && typeof computed.path === 'string' && typeof computed.url === 'string') return computed.path;
  return inherited;
}

// ---------- Why a component rendered ----------

var contextOwners = new WeakMap();

function contextName(context) {
  return context.displayName || contextOwners.get(context) || 'Context';
}

function renderReasons(fiber) {
  var previous = fiber.alternate;
  var reasons = [];
  var hook = fiber.memoizedState;
  var previousHook = previous.memoizedState;
  while (hook && previousHook && typeof hook === 'object' && 'next' in hook) {
    if (hook.queue && !Object.is(hook.memoizedState, previousHook.memoizedState)) {
      reasons.push(hook.queue.getSnapshot ? 'store (useSelector)' : 'state');
    }
    hook = hook.next;
    previousHook = previousHook.next;
  }
  var dependency = fiber.dependencies && fiber.dependencies.firstContext;
  var previousDependency = previous.dependencies && previous.dependencies.firstContext;
  while (dependency && previousDependency) {
    if (!Object.is(dependency.memoizedValue, previousDependency.memoizedValue)) {
      reasons.push('context: ' + contextName(dependency.context));
    }
    dependency = dependency.next;
    previousDependency = previousDependency.next;
  }
  var props = fiber.memoizedProps;
  var previousProps = previous.memoizedProps;
  if (props !== previousProps && props && previousProps && typeof props === 'object') {
    var changed = Object.keys(props).filter(function (key) {
      return !Object.is(props[key], previousProps[key]);
    });
    Object.keys(previousProps).forEach(function (key) {
      if (!(key in props)) changed.push(key);
    });
    if (changed.length) reasons.push('props: ' + changed.slice(0, 4).join(', ') + (changed.length > 4 ? '…' : ''));
  }
  if (!reasons.length) reasons.push('parent rendered (props equal)');
  return Array.from(new Set(reasons));
}

// ---------- Redux ----------

var reduxStore = null;
var lastStoreUpdateAt = 0;
var slicesSinceCommit = new Set();

function changedSlices(previous, next) {
  var paths = [];
  if (!previous || !next || typeof next !== 'object') return paths;
  Object.keys(next).forEach(function (key) {
    if (Object.is(previous[key], next[key])) return;
    var before = previous[key];
    var after = next[key];
    var inner =
      before && after && typeof after === 'object' && !Array.isArray(after)
        ? Object.keys(after).filter(function (subKey) {
            return !Object.is(before[subKey], after[subKey]);
          })
        : [];
    if (inner.length && inner.length <= 6) {
      inner.forEach(function (subKey) {
        paths.push(key + '.' + subKey);
      });
    } else {
      paths.push(key);
    }
  });
  return paths;
}

function attachStore(store) {
  if (reduxStore || !store || typeof store.subscribe !== 'function' || typeof store.getState !== 'function') return;
  reduxStore = store;
  var previous = store.getState();
  // Subscribed before the tracker wraps subscribe, so the probe's own listener is not counted.
  store.subscribe(function () {
    var next = store.getState();
    current.store.dispatches += 1;
    if (next === previous) {
      current.store.noops += 1;
      return;
    }
    changedSlices(previous, next).forEach(function (path) {
      current.store.slices.set(path, (current.store.slices.get(path) || 0) + 1);
      slicesSinceCommit.add(path);
    });
    previous = next;
    lastStoreUpdateAt = Date.now();
  });
  tracker.wrapSubscribe(store, 'subscribe', 'Redux store');
  var dispatch = store.dispatch;
  store.dispatch = function perfTracked_dispatch(action) {
    var type = typeof action === 'function' ? '(thunk)' : String((action && action.type) || '(unknown)');
    var entry = current.actions.get(type) || { type: type, count: 0, ms: 0 };
    var startedAt = performance.now();
    try {
      return dispatch.apply(this, arguments);
    } finally {
      entry.count += 1;
      entry.ms += performance.now() - startedAt;
      current.actions.set(type, entry);
    }
  };
}

// ---------- Inspector ----------
// Request / response bodies and socket messages for the dashboard's Inspector tab, kept only while
// it is on there (the server says so in its reply to /js) and sent outside the samples, so
// recordings and exports never contain them. Mirrors probe/perfProbe.js: credential headers and
// password fields are masked.

var INSPECT_MAX_CHARS = 200000;
var INSPECT_MAX_QUEUED = 500;
var INSPECT_MAX_QUEUED_CHARS = 4000000;
var SECRET_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|login|passcode|x-auth-token|x-api-key)$/i;
var SECRET_FIELD = /pass(word|code)/i;
var inspecting = false;
var inspectSequence = 0;
var inspectQueue = [];
var inspectQueuedChars = 0;
var inspectDropped = 0;

function setInspecting(on) {
  inspecting = on;
  if (!on) {
    inspectQueue = [];
    inspectQueuedChars = 0;
    inspectDropped = 0;
  }
}

function entryChars(entry) {
  return ((entry.requestBody && entry.requestBody.length) || 0) + ((entry.responseBody && entry.responseBody.length) || 0) + ((entry.body && entry.body.length) || 0);
}

function inspectPush(entry) {
  if (!inspecting) return;
  inspectSequence += 1;
  inspectQueue.push(Object.assign({ id: sessionId + '-' + inspectSequence, at: Date.now() }, entry));
  inspectQueuedChars += entryChars(entry);
  while (inspectQueue.length > INSPECT_MAX_QUEUED || (inspectQueuedChars > INSPECT_MAX_QUEUED_CHARS && inspectQueue.length > 1)) {
    inspectQueuedChars -= entryChars(inspectQueue.shift());
    inspectDropped += 1;
  }
}

function takeInspected() {
  var taken = { entries: inspectQueue, dropped: inspectDropped };
  inspectQueue = [];
  inspectQueuedChars = 0;
  inspectDropped = 0;
  return taken;
}

function clip(text) {
  if (typeof text !== 'string') return { body: null, truncated: 0 };
  return text.length > INSPECT_MAX_CHARS ? { body: text.slice(0, INSPECT_MAX_CHARS), truncated: text.length } : { body: text, truncated: 0 };
}

function maskHeaders(headers) {
  var masked = {};
  Object.keys(headers || {}).forEach(function (name) {
    masked[name] = SECRET_HEADER.test(name) ? '***' : headers[name];
  });
  return masked;
}

function maskFields(value) {
  if (Array.isArray(value)) return value.map(maskFields);
  if (!value || typeof value !== 'object') return value;
  var masked = {};
  Object.keys(value).forEach(function (key) {
    masked[key] = SECRET_FIELD.test(key) ? '***' : maskFields(value[key]);
  });
  return masked;
}

function maskBody(text) {
  if (typeof text !== 'string' || !SECRET_FIELD.test(text)) return text;
  try {
    return JSON.stringify(maskFields(JSON.parse(text)));
  } catch (error) {
    return text.replace(/([^&=?\s]*pass(?:word|code)[^&=]*=)[^&]*/gi, '$1***');
  }
}

function parseHeaderBlock(text) {
  var headers = {};
  String(text || '')
    .split(/\r?\n/)
    .forEach(function (line) {
      var separator = line.indexOf(':');
      if (separator > 0) headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
    });
  return headers;
}

function headersObject(headers) {
  var result = {};
  if (!headers) return result;
  try {
    if (typeof headers.forEach === 'function' && !Array.isArray(headers)) {
      headers.forEach(function (value, name) {
        result[String(name).toLowerCase()] = String(value);
      });
    } else if (Array.isArray(headers)) {
      headers.forEach(function (pair) {
        result[String(pair[0]).toLowerCase()] = String(pair[1]);
      });
    } else {
      Object.keys(headers).forEach(function (name) {
        result[name.toLowerCase()] = String(headers[name]);
      });
    }
  } catch (error) {
    // unreadable headers: shown as none
  }
  return result;
}

function bytesToText(data, maxChars) {
  if (typeof data === 'string') return data;
  if (!data || typeof data.byteLength !== 'number') return null;
  try {
    var bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, maxChars)));
  } catch (error) {
    return null;
  }
}

function requestBodyText(body) {
  if (body == null) return null;
  if (typeof body === 'string') return maskBody(body);
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return maskBody(String(body));
  if (typeof FormData !== 'undefined' && body instanceof FormData) return '(FormData)';
  if (typeof Blob !== 'undefined' && body instanceof Blob) return '(Blob, ' + body.size + ' bytes)';
  if (typeof body.byteLength === 'number') return bytesToText(body, INSPECT_MAX_CHARS);
  return '(' + ((body.constructor && body.constructor.name) || typeof body) + ')';
}

function inspectHttp(request, status, ms, responseHeaders, responseText) {
  var response = clip(responseText);
  var sent = clip(request.body);
  inspectPush({
    kind: 'http',
    method: request.method.toUpperCase(),
    url: request.url,
    endpoint: endpointKey(request.method, request.url),
    status: status,
    ms: Math.round(ms),
    requestHeaders: maskHeaders(request.headers),
    requestBody: sent.body,
    requestTruncated: sent.truncated,
    responseHeaders: maskHeaders(responseHeaders),
    responseBody: response.body,
    responseTruncated: response.truncated
  });
}

// ---------- WebSocket ----------
// Messages per socket and, for STOMP, per destination (topic), like probe/perfProbe.js. Only the
// command and the destination / subscription headers are counted; bodies only in the Inspector.

var NON_STOMP_TOPIC = '(messages)';
var MAX_HEADER_CHARS = 512;
var STOMP_COMMANDS = new Set(['CONNECT', 'STOMP', 'CONNECTED', 'SEND', 'SUBSCRIBE', 'UNSUBSCRIBE', 'MESSAGE', 'RECEIPT', 'ERROR', 'ACK', 'NACK', 'BEGIN', 'COMMIT', 'ABORT', 'DISCONNECT']);
var topicsSinceCommit = new Set();
var lastSocketMessageAt = 0;

function socketKey(url) {
  var match = String(url).match(/^(?:wss?:\/\/)?([^/?#]*)([^?#]*)/);
  return match ? match[1] + foldPath(match[2]) : String(url);
}

function dataText(data) {
  if (typeof data === 'string') return data.slice(0, MAX_HEADER_CHARS);
  var text = bytesToText(data, MAX_HEADER_CHARS);
  return text ? text.slice(0, MAX_HEADER_CHARS) : '';
}

function dataBytes(data) {
  if (typeof data === 'string') return data.length;
  return (data && (data.byteLength != null ? data.byteLength : data.size)) || 0;
}

function stompFrames(text, full) {
  var frames = [];
  var parts = text.split('\0');
  for (var index = 0; index < parts.length; index += 1) {
    var frame = parts[index].replace(/^[\r\n]+/, '');
    if (!frame) continue;
    var blank = frame.search(/\r?\n\r?\n/);
    var head = blank === -1 ? frame : frame.slice(0, blank);
    var lines = head.split(/\r?\n/);
    if (!STOMP_COMMANDS.has(lines[0])) return frames.length ? frames : null;
    var headers = {};
    for (var line = 1; line < lines.length; line += 1) {
      var separator = lines[line].indexOf(':');
      if (separator <= 0) continue;
      var name = lines[line].slice(0, separator);
      if (!full && name !== 'destination' && name !== 'subscription' && name !== 'id') continue;
      if (!(name in headers)) headers[name] = lines[line].slice(separator + 1);
    }
    frames.push({ command: lines[0], headers: headers, body: full && blank !== -1 ? frame.slice(blank).replace(/^\r?\n\r?\n/, '') : '' });
  }
  return frames;
}

function socketEntry(socket, topic) {
  var key = socket + '\u0000' + topic;
  var entry = current.sockets.get(key);
  if (!entry) {
    entry = { socket: socket, topic: topic, messages: 0, bytes: 0, sent: 0, sentBytes: 0, commits: 0, renders: 0, renderMs: 0 };
    current.sockets.set(key, entry);
  }
  return entry;
}

function connectionEntry(socket) {
  var entry = current.socketConnections.get(socket);
  if (!entry) {
    entry = { socket: socket, opens: 0, closes: 0, errors: 0, closeCodes: {} };
    current.socketConnections.set(socket, entry);
  }
  return entry;
}

function inspectSocketData(socket, direction, data, subscriptions) {
  var text = bytesToText(data, INSPECT_MAX_CHARS);
  if (text == null) {
    inspectPush({ kind: 'ws', socket: socket, direction: direction, topic: NON_STOMP_TOPIC, destination: null, command: null, headers: {}, body: '(binary, ' + dataBytes(data) + ' bytes)', bytes: dataBytes(data) });
    return;
  }
  var frames = stompFrames(text, true);
  if (!frames) {
    if (!text.trim()) return;
    var clipped = clip(text);
    inspectPush({ kind: 'ws', socket: socket, direction: direction, topic: NON_STOMP_TOPIC, destination: null, command: null, headers: {}, body: clipped.body, truncated: clipped.truncated, bytes: dataBytes(data) });
    return;
  }
  frames.forEach(function (frame) {
    var destination = frame.headers.destination || subscriptions.get(frame.headers.subscription) || null;
    var body = clip(frame.command === 'CONNECT' || frame.command === 'STOMP' ? '' : frame.body);
    inspectPush({
      kind: 'ws',
      socket: socket,
      direction: direction,
      topic: destination ? foldPath(destination) : '(' + frame.command.toLowerCase() + ')',
      destination: destination,
      command: frame.command,
      headers: maskHeaders(frame.headers),
      body: body.body,
      truncated: body.truncated,
      bytes: frame.body.length
    });
  });
}

function trackSocket(webSocket, url) {
  var socket = socketKey(url);
  var subscriptions = new Map();
  var topicOf = function (frame) {
    var destination = frame.headers.destination || subscriptions.get(frame.headers.subscription);
    return destination ? foldPath(destination) : '(' + frame.command.toLowerCase() + ')';
  };
  // The probe's own listeners: not the app's resources.
  raw.addEventListener.call(webSocket, 'open', function () {
    connectionEntry(socket).opens += 1;
  });
  raw.addEventListener.call(webSocket, 'error', function () {
    connectionEntry(socket).errors += 1;
  });
  raw.addEventListener.call(webSocket, 'close', function (event) {
    var entry = connectionEntry(socket);
    entry.closes += 1;
    var code = String(event && event.code != null ? event.code : '?');
    entry.closeCodes[code] = (entry.closeCodes[code] || 0) + 1;
  });
  raw.addEventListener.call(webSocket, 'message', function (event) {
    if (inspecting) {
      try {
        inspectSocketData(socket, 'in', event.data, subscriptions);
      } catch (error) {
        current.probeErrors = (current.probeErrors || 0) + 1;
      }
    }
    try {
      var bytes = dataBytes(event.data);
      var frames = stompFrames(dataText(event.data), false);
      var topics = frames ? frames.filter(function (frame) { return frame.command === 'MESSAGE'; }).map(topicOf) : [NON_STOMP_TOPIC];
      if (!topics.length) return;
      topics.forEach(function (topic) {
        var entry = socketEntry(socket, topic);
        entry.messages += 1;
        entry.bytes += bytes / topics.length;
        topicsSinceCommit.add(socket + '\u0000' + topic);
      });
      lastSocketMessageAt = Date.now();
    } catch (error) {
      current.probeErrors = (current.probeErrors || 0) + 1;
    }
  });
  var send = webSocket.send;
  webSocket.send = function perfTracked_send(data) {
    try {
      var frames = stompFrames(dataText(data), false);
      if (frames) {
        frames.forEach(function (frame) {
          if (frame.command === 'SUBSCRIBE' && frame.headers.id && frame.headers.destination) subscriptions.set(frame.headers.id, frame.headers.destination);
          if (frame.command === 'UNSUBSCRIBE' && frame.headers.id) subscriptions.delete(frame.headers.id);
          if (frame.command === 'SEND') {
            var entry = socketEntry(socket, topicOf(frame));
            entry.sent += 1;
            entry.sentBytes += dataBytes(data) / frames.length;
          }
        });
      } else {
        var plain = socketEntry(socket, NON_STOMP_TOPIC);
        plain.sent += 1;
        plain.sentBytes += dataBytes(data);
      }
      if (inspecting) inspectSocketData(socket, 'out', data, subscriptions);
    } catch (error) {
      current.probeErrors = (current.probeErrors || 0) + 1;
    }
    return send.apply(this, arguments);
  };
}

function installSocketHook() {
  var NativeWebSocket = window.WebSocket;
  if (!NativeWebSocket || NativeWebSocket.__perfProbe) return;
  var PerfWebSocket = function WebSocket(url, protocols) {
    var instance = protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
    try {
      trackSocket(instance, url);
    } catch (error) {
      current.probeErrors = (current.probeErrors || 0) + 1;
    }
    return instance;
  };
  PerfWebSocket.prototype = NativeWebSocket.prototype;
  ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (name) {
    PerfWebSocket[name] = NativeWebSocket[name];
  });
  PerfWebSocket.__perfProbe = true;
  window.WebSocket = PerfWebSocket;
}

// ---------- Network ----------
// fetch and XMLHttpRequest, counted per endpoint (ids and query values folded). A duplicate is the
// exact same request while it is in flight or less than a second after it finished.

var DUPLICATE_WINDOW_MS = 1000;
var inFlight = new Map();
var lastFinished = new Map();

function endpointKey(method, url) {
  var match = String(url).match(/^(?:https?:\/\/)?([^/?#]*)([^?#]*)(?:\?([^#]*))?/);
  if (!match) return method + ' ' + url;
  var path = match[2]
    .split('/')
    .map(function (part) {
      return /^\d+$|^[0-9a-f-]{16,}$|^[0-9a-f]{24}$/i.test(part) ? ':id' : part;
    })
    .join('/');
  var params = match[3]
    ? '?' +
      match[3]
        .split('&')
        .map(function (pair) {
          return pair.split('=')[0];
        })
        .sort()
        .join('&')
    : '';
  return method.toUpperCase() + ' ' + match[1] + path + params;
}

function absoluteUrl(url) {
  try {
    return new URL(String(url), location.href).href;
  } catch (error) {
    return String(url);
  }
}

function requestStarted(method, url) {
  var full = absoluteUrl(url);
  if (full.indexOf(location.origin + ENDPOINT + '/') === 0) return null;
  var exact = method.toUpperCase() + ' ' + full;
  var startedAt = performance.now();
  var duplicate = (inFlight.get(exact) || 0) > 0 || Date.now() - (lastFinished.get(exact) || 0) < DUPLICATE_WINDOW_MS;
  inFlight.set(exact, (inFlight.get(exact) || 0) + 1);
  return { key: endpointKey(method, full), exact: exact, startedAt: startedAt, duplicate: duplicate };
}

// Both maps are keyed by the full URL, so they must not keep every URL the app ever requested
// (like markFinished in probe/perfProbe.js): finished entries older than the window are dropped.
function markFinished(exact, now) {
  var left = (inFlight.get(exact) || 1) - 1;
  if (left > 0) inFlight.set(exact, left);
  else inFlight.delete(exact);
  lastFinished.delete(exact);
  lastFinished.set(exact, now);
  var iterator = lastFinished.entries();
  for (var step = iterator.next(); !step.done; step = iterator.next()) {
    if (now - step.value[1] < DUPLICATE_WINDOW_MS) break;
    lastFinished.delete(step.value[0]);
  }
}

function requestFinished(request, status, bytes) {
  if (!request) return;
  var ms = performance.now() - request.startedAt;
  markFinished(request.exact, Date.now());
  var entry = current.network.get(request.key) || { key: request.key, count: 0, ms: 0, maxMs: 0, bytes: 0, errors: 0, duplicates: 0 };
  entry.count += 1;
  entry.ms += ms;
  entry.maxMs = Math.max(entry.maxMs, Math.round(ms));
  entry.bytes += bytes || 0;
  if (!status || status >= 400) entry.errors += 1;
  if (request.duplicate) entry.duplicates += 1;
  current.network.set(request.key, entry);
}

function installNetworkHooks() {
  var Request = window.XMLHttpRequest;
  if (Request && !Request.prototype.__perfProbe) {
    Request.prototype.__perfProbe = true;
    var open = Request.prototype.open;
    var send = Request.prototype.send;
    var setRequestHeader = Request.prototype.setRequestHeader;
    Request.prototype.open = function perfTracked_open(method, url) {
      this.__perfRequest = { method: method || 'GET', url: absoluteUrl(url), headers: {} };
      return open.apply(this, arguments);
    };
    Request.prototype.setRequestHeader = function perfTracked_setRequestHeader(name, value) {
      if (inspecting && this.__perfRequest) this.__perfRequest.headers[String(name).toLowerCase()] = String(value);
      return setRequestHeader.apply(this, arguments);
    };
    Request.prototype.send = function perfTracked_send(sentBody) {
      var info = this.__perfRequest;
      var request = info ? requestStarted(info.method, info.url) : null;
      if (request) {
        var xhr = this;
        var inspected = inspecting;
        if (inspected) {
          try {
            info.body = requestBodyText(sentBody);
          } catch (error) {
            info.body = null;
          }
        }
        raw.addEventListener.call(xhr, 'loadend', function perfTracked_loadend() {
          var bytes = 0;
          try {
            bytes = Number(xhr.getResponseHeader('content-length')) || 0;
          } catch (error) {
            bytes = 0;
          }
          requestFinished(request, xhr.status, bytes);
          if (inspected && inspecting) {
            try {
              var type = xhr.responseType;
              var text = !type || type === 'text' ? xhr.responseText : type === 'json' ? JSON.stringify(xhr.response) : type === 'arraybuffer' ? bytesToText(xhr.response, INSPECT_MAX_CHARS) : '(' + type + ')';
              inspectHttp(info, xhr.status, performance.now() - request.startedAt, parseHeaderBlock(xhr.getAllResponseHeaders()), text);
            } catch (error) {
              current.probeErrors = (current.probeErrors || 0) + 1;
            }
          }
        });
      }
      return send.apply(this, arguments);
    };
  }
  var originalFetch = window.fetch;
  if (typeof originalFetch === 'function' && !originalFetch.__perfProbe) {
    var tracked = function perfTracked_fetch(input, init) {
      var method = (init && init.method) || (input && typeof input === 'object' && input.method) || 'GET';
      var url = input && typeof input === 'object' && 'url' in input ? input.url : input;
      var request = requestStarted(method, url);
      var promise = originalFetch.apply(this, arguments);
      if (!request) return promise;
      var inspected = inspecting;
      var info = null;
      if (inspected) {
        info = {
          method: String(method),
          url: absoluteUrl(url),
          headers: headersObject((init && init.headers) || (input && typeof input === 'object' && input.headers)),
          body: null
        };
        try {
          info.body = requestBodyText(init && init.body);
        } catch (error) {
          info.body = null;
        }
      }
      return promise.then(
        function (response) {
          requestFinished(request, response.status, Number(response.headers.get('content-length')) || 0);
          if (inspected && inspecting) {
            // A copy is read so the app's own response stays unread.
            var elapsed = performance.now() - request.startedAt;
            response
              .clone()
              .text()
              .then(
                function (text) {
                  inspectHttp(info, response.status, elapsed, headersObject(response.headers), text);
                },
                function () {
                  inspectHttp(info, response.status, elapsed, headersObject(response.headers), null);
                }
              );
          }
          return response;
        },
        function (error) {
          requestFinished(request, 0, 0);
          throw error;
        }
      );
    };
    tracked.__perfProbe = true;
    window.fetch = tracked;
  }
}

// ---------- Forced synchronous layout ----------
// Reading a layout property after the page changed forces the browser to lay out right away. Clean
// reads take microseconds, so a read that takes over 1 ms did a layout: it is charged to its call
// site (and to the component whose effect is running, when there is one). Works in every browser.

var layoutPatches = []; // { target, name, original } to undo the wrappers
var layoutWrapped = false;

function installLayoutReads() {
  if (layoutWrapped) return;
  layoutWrapped = true;
  var reads = [
    ['HTMLElement', ['offsetTop', 'offsetLeft', 'offsetWidth', 'offsetHeight', 'offsetParent', 'innerText']],
    ['Element', ['clientTop', 'clientLeft', 'clientWidth', 'clientHeight', 'scrollTop', 'scrollLeft', 'scrollWidth', 'scrollHeight']]
  ];
  reads.forEach(function (group) {
    var Class = window[group[0]];
    if (!Class || !Class.prototype) return;
    group[1].forEach(function (name) {
      var descriptor = Object.getOwnPropertyDescriptor(Class.prototype, name);
      if (!descriptor || typeof descriptor.get !== 'function' || !descriptor.configurable) return;
      var get = descriptor.get;
      layoutPatches.push({ target: Class.prototype, name: name, descriptor: descriptor });
      Object.defineProperty(Class.prototype, name, {
        configurable: true,
        enumerable: descriptor.enumerable,
        set: descriptor.set,
        get: function perfTracked_layoutRead() {
          var startedAt = performance.now();
          var value = get.call(this);
          var ms = performance.now() - startedAt;
          if (ms >= FORCED_LAYOUT_MS) noteForcedLayout(name, ms);
          return value;
        }
      });
    });
  });
  ['getBoundingClientRect', 'getClientRects'].forEach(function (name) {
    var proto = window.Element && window.Element.prototype;
    var original = proto && proto[name];
    if (typeof original !== 'function') return;
    layoutPatches.push({ target: proto, name: name, descriptor: Object.getOwnPropertyDescriptor(proto, name) });
    proto[name] = function perfTracked_layoutCall() {
      var startedAt = performance.now();
      var value = original.apply(this, arguments);
      var ms = performance.now() - startedAt;
      if (ms >= FORCED_LAYOUT_MS) noteForcedLayout(name + '()', ms);
      return value;
    };
  });
}

// Chrome (traced by the dashboard) names the script that forced a layout itself; the wrappers would
// be the only frame it sees, so they come off while it watches.
function uninstallLayoutReads() {
  if (!layoutWrapped) return;
  layoutWrapped = false;
  layoutPatches.forEach(function (patch) {
    Object.defineProperty(patch.target, patch.name, patch.descriptor);
  });
  layoutPatches = [];
}

function stackSite() {
  var stack;
  try {
    stack = new Error().stack;
  } catch (error) {
    return null;
  }
  if (!stack) return null;
  var frames = String(stack)
    .split('\n')
    .map(function (line) {
      return line.trim();
    })
    .filter(function (line) {
      return line && line !== 'Error' && !/perfTracked|noteForcedLayout|stackSite/.test(line);
    });
  return frames.slice(0, 4).join('\n') || null;
}

function noteForcedLayout(property, ms) {
  var site = stackSite();
  var owner = tracker.owner();
  var key = (site ? site.split('\n')[0] : property) + '\u0000' + (owner ? owner.name : '');
  var entry = current.forcedLayouts.get(key);
  if (!entry) {
    entry = { property: property, site: site, component: owner ? owner.name : null, count: 0, ms: 0, maxMs: 0 };
    current.forcedLayouts.set(key, entry);
  }
  entry.count += 1;
  entry.ms += ms;
  entry.maxMs = Math.max(entry.maxMs, ms);
}

// ---------- Browser timing APIs ----------

var hasLongTaskApi = false;
var lcp = null;
var lcpSent = null;
var pageLoad = null;

function observe(type, callback, extra) {
  try {
    var observer = new PerformanceObserver(function (list) {
      list.getEntries().forEach(callback);
    });
    var options = { type: type, buffered: true };
    if (extra) Object.keys(extra).forEach(function (key) { options[key] = extra[key]; });
    observer.observe(options);
    return true;
  } catch (error) {
    return false;
  }
}

function installTimingObservers() {
  // Real main-thread tasks (Chromium). Elsewhere the timer-drift fallback below measures them.
  hasLongTaskApi = observe('longtask', function (entry) {
    current.longTasks += 1;
    current.longTaskMs += entry.duration;
    current.maxBlockMs = Math.max(current.maxBlockMs, entry.duration);
  });
  // Long animation frames (Chromium 123+): which scripts made a frame late.
  observe('long-animation-frame', function (entry) {
    if (entry.duration < LONG_TASK_MS) return;
    current.loafs.push({
      ms: round(entry.duration),
      blockingMs: round(entry.blockingDuration || 0),
      renderMs: round(entry.renderStart ? entry.startTime + entry.duration - entry.renderStart : 0),
      styleLayoutMs: round(entry.styleAndLayoutStart ? entry.startTime + entry.duration - entry.styleAndLayoutStart : 0),
      scripts: (entry.scripts || [])
        .slice()
        .sort(function (a, b) {
          return b.duration - a.duration;
        })
        .slice(0, 4)
        .map(function (script) {
          return {
            ms: round(script.duration),
            forcedLayoutMs: round(script.forcedStyleAndLayoutDuration || 0),
            invoker: String(script.invoker || '').slice(0, 120),
            invokerType: script.invokerType || null,
            fn: script.sourceFunctionName || null,
            url: script.sourceURL || null,
            char: typeof script.sourceCharPosition === 'number' ? script.sourceCharPosition : null
          };
        })
    });
  });
  observe('layout-shift', function (entry) {
    if (entry.hadRecentInput) return;
    current.clsValue += entry.value;
    current.shifts.push({
      value: Math.round(entry.value * 10000) / 10000,
      nodes: (entry.sources || [])
        .map(function (source) {
          return elementLabel(source.node);
        })
        .filter(Boolean)
        .slice(0, 3)
    });
  });
  observe('largest-contentful-paint', function (entry) {
    lcp = { ms: Math.round(entry.startTime), element: elementLabel(entry.element), size: entry.size, url: entry.url ? String(entry.url).slice(0, 160) : null };
  });
  // Interactions (INP): every event of one interaction shares an interactionId; the slowest counts.
  observe(
    'event',
    function (entry) {
      if (!entry.interactionId) return;
      var previous = current.interactions.get(entry.interactionId);
      if (previous && previous.ms >= entry.duration) return;
      current.interactions.set(entry.interactionId, {
        type: entry.name,
        ms: Math.round(entry.duration),
        inputDelayMs: Math.round(entry.processingStart - entry.startTime),
        processingMs: Math.round(entry.processingEnd - entry.processingStart),
        presentationMs: Math.round(entry.startTime + entry.duration - entry.processingEnd),
        target: elementLabel(entry.target)
      });
    },
    { durationThreshold: 40 }
  );
}

function readPageLoad() {
  try {
    var navigation = performance.getEntriesByType('navigation')[0];
    if (!navigation || !navigation.loadEventEnd) return null;
    return {
      ttfbMs: Math.round(navigation.responseStart),
      domContentLoadedMs: Math.round(navigation.domContentLoadedEventEnd),
      loadMs: Math.round(navigation.loadEventEnd),
      transferKb: Math.round((navigation.transferSize || 0) / 102.4) / 10
    };
  } catch (error) {
    return null;
  }
}

// ---------- React commits ----------

var REACT_FIBER_NAMES = {
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

function componentName(fiber) {
  var type = fiber.type;
  if (!type) return null;
  if (typeof type === 'function') return type.displayName || type.name || 'Anonymous';
  if (typeof type === 'object') {
    if (type.displayName) return type.displayName;
    var inner = type.render || type.type;
    if (inner) return inner.displayName || inner.name || 'Anonymous';
  }
  return null;
}

function fiberLabel(fiber) {
  return componentName(fiber) || REACT_FIBER_NAMES[fiber.tag] || null;
}

// The route a fiber is rendered under: React Router's route paths from the fiber upwards.
function routeOfFiber(fiber) {
  var parts = [];
  for (var node = fiber; node; node = node.return) {
    var props = node.memoizedProps;
    if (props && typeof props === 'object' && props.routeContext && props.match && props.match.route) {
      var routePath = props.match.route.path;
      if (typeof routePath === 'string' && routePath) {
        parts.unshift(routePath);
        if (routePath.charAt(0) === '/') break;
      }
    }
  }
  if (!parts.length) return null;
  return parts.reduce(function (pattern, part) {
    return joinPattern(pattern, part);
  }, '/');
}

// The component that scheduled an update (React's profiling build keeps them on
// root.memoizedUpdaters): the closest one of ours at or above it, and its route.
function describeUpdater(fiber) {
  var name = null;
  for (var node = fiber; node; node = node.return) {
    var nodeName = COMPONENT_TAGS.has(node.tag) ? componentName(node) : null;
    if (nodeName && ownComponents.has(nodeName)) {
      name = nodeName;
      break;
    }
  }
  return { component: name || componentName(fiber) || '(library)', screen: routeOfFiber(fiber) || currentScreen() };
}

function recordTriggers(root, commitMs) {
  var updaters = root.memoizedUpdaters;
  if (!updaters || !updaters.size) return;
  updaters.forEach(function (fiber) {
    var info = describeUpdater(fiber);
    var key = info.screen + '\u0000' + info.component;
    var entry = current.triggers.get(key) || { component: info.component, screen: info.screen, commits: 0, ms: 0 };
    entry.commits += 1;
    entry.ms += commitMs / updaters.size;
    current.triggers.set(key, entry);
  });
}

// Mirrors onCommit in probe/perfProbe.js; the screen is the route pattern instead of a navigation route.
function onCommit(root) {
  var rootFiber = root.current;
  if (!rootFiber) return;
  var commitMs = rootFiber.actualDuration || 0;
  var renderStartTime = rootFiber.actualStartTime;
  var wasProcessed = function (fiber) {
    return !(renderStartTime >= 0) || fiber.actualStartTime >= renderStartTime;
  };
  current.commits += 1;
  current.commitMs += commitMs;
  try {
    recordTriggers(root, commitMs);
  } catch (error) {
    current.probeErrors = (current.probeErrors || 0) + 1;
  }
  var fallbackScreen = foldPath(locationPath());
  var deepestRoute = null;

  var commitComponents = new Map();
  var commitRenders = 0;
  var stack = [{ fiber: rootFiber, route: null, depth: 0, owner: null }];
  while (stack.length) {
    var item = stack.pop();
    var fiber = item.fiber;
    if (!wasProcessed(fiber)) continue;
    var route = routePattern(fiber, item.route);
    var depth = route !== item.route ? item.depth + 1 : item.depth;
    if (route && route !== item.route && (!deepestRoute || depth > deepestRoute.depth)) deepestRoute = { depth: depth, route: route };
    var screen = route || fallbackScreen;
    var isComponent = COMPONENT_TAGS.has(fiber.tag);
    var name = isComponent ? componentName(fiber) : null;
    var isOwn = name !== null && ownComponents.has(name);
    var performedWork = isComponent && (fiber.flags & PERFORMED_WORK) === PERFORMED_WORK;
    var ownsTime = isOwn && performedWork;
    var label = fiberLabel(fiber);
    if (fiber.tag === CONTEXT_PROVIDER_TAG && fiber.type) {
      var context = fiber.type._context || fiber.type;
      if (!contextOwners.has(context) && item.owner) contextOwners.set(context, item.owner);
    }
    if (!reduxStore && fiber.memoizedProps && fiber.memoizedProps.store) attachStore(fiber.memoizedProps.store);
    var owner = ownsTime ? name : item.owner || '(library)';
    var descend = fiber.actualDuration !== 0 && (fiber.alternate === null || fiber.alternate.child !== fiber.child);

    var selfMs = 0;
    if (descend) {
      selfMs = fiber.actualDuration;
      for (var child = fiber.child; child !== null; child = child.sibling) {
        selfMs -= child.actualDuration;
        stack.push({ fiber: child, route: route, depth: depth, owner: ownsTime ? name : item.owner });
      }
    }

    var rendered = (isOwn || !item.owner) && performedWork;
    if (selfMs <= 0 && !rendered) continue;

    var key = screen + '\u0000' + owner;
    var entry = current.components.get(key);
    if (!entry) {
      entry = { screen: screen, component: owner, selfMs: 0, libraryMs: 0, library: {}, renders: 0, mounts: 0, compiled: false, reasons: {} };
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
      if (fiber.updateQueue && fiber.updateQueue.memoCache) entry.compiled = true;
      entry.renders += 1;
      commitRenders += 1;
      if (fiber.alternate === null) entry.mounts += 1;
      else if (isOwn) renderReasons(fiber).forEach(function (reason) { entry.reasons[reason] = (entry.reasons[reason] || 0) + 1; });
    }
    if (selfMs > 0) {
      current.screens.set(screen, (current.screens.get(screen) || 0) + selfMs);
      commitComponents.set(owner, (commitComponents.get(owner) || 0) + selfMs);
    }
  }
  if (deepestRoute) {
    routeForPath.set(locationPath(), deepestRoute.route);
    if (routeForPath.size > 500) routeForPath.delete(routeForPath.keys().next().value);
  }

  if (slicesSinceCommit.size) {
    if (Date.now() - lastStoreUpdateAt < 100 + commitMs) {
      slicesSinceCommit.forEach(function (path) {
        var sliceKey = 'slice:' + path;
        var slice = current.actions.get(sliceKey) || { type: sliceKey, count: 0, ms: 0, commits: 0, renders: 0, renderMs: 0 };
        slice.commits += 1;
        slice.renders += commitRenders / slicesSinceCommit.size;
        slice.renderMs += commitMs / slicesSinceCommit.size;
        current.actions.set(sliceKey, slice);
      });
    }
    slicesSinceCommit = new Set();
  }

  if (topicsSinceCommit.size) {
    if (Date.now() - lastSocketMessageAt < 100 + commitMs) {
      topicsSinceCommit.forEach(function (key) {
        var parts = key.split('\u0000');
        var entry = socketEntry(parts[0], parts[1]);
        entry.commits += 1;
        entry.renders += commitRenders / topicsSinceCommit.size;
        entry.renderMs += commitMs / topicsSinceCommit.size;
      });
    }
    topicsSinceCommit = new Set();
  }

  if (commitMs >= 16) {
    current.slowCommits.push({
      ms: round(commitMs),
      top: Array.from(commitComponents.entries())
        .sort(function (a, b) {
          return b[1] - a[1];
        })
        .slice(0, 5)
        .map(function (pair) {
          return { component: pair[0], ms: round(pair[1]) };
        })
    });
  }
}

function safeCommit(root) {
  try {
    if (useEffectWrapping) tracker.wrapPendingEffects(root.current);
  } catch (error) {
    current.probeErrors = (current.probeErrors || 0) + 1;
  }
  try {
    onCommit(root);
  } catch (error) {
    current.probeErrors = (current.probeErrors || 0) + 1;
  }
}

function safeUnmount(fiber) {
  try {
    tracker.fiberUnmounted(fiber);
  } catch (error) {
    current.probeErrors = (current.probeErrors || 0) + 1;
  }
}

// React DOM's profiling build tells which component's effects are running; without that API the
// probe wraps pending useEffect callbacks at each commit instead (layout effects then stay unowned).
function attachRenderer(renderer) {
  if (renderer && typeof renderer.injectProfilingHooks === 'function') {
    try {
      renderer.injectProfilingHooks(tracker.profilingHooks());
      return;
    } catch (error) {
      // fall through to wrapping
    }
  }
  useEffectWrapping = true;
}

function installHook() {
  var existing = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (existing) {
    // React DevTools (the extension) is installed: chain into its hook.
    var originalCommit = existing.onCommitFiberRoot;
    existing.onCommitFiberRoot = function (rendererId, root) {
      safeCommit(root);
      return originalCommit && originalCommit.apply(this, arguments);
    };
    var originalUnmount = existing.onCommitFiberUnmount;
    existing.onCommitFiberUnmount = function (rendererId, fiber) {
      safeUnmount(fiber);
      return originalUnmount && originalUnmount.apply(this, arguments);
    };
    var originalInject = existing.inject;
    existing.inject = function (renderer) {
      var id = originalInject.apply(this, arguments);
      attachRenderer(renderer);
      raw.setTimeout(start, 0);
      return id;
    };
    return;
  }
  var nextRendererId = 0;
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    isDisabled: false,
    renderers: new Map(),
    inject: function (renderer) {
      nextRendererId += 1;
      this.renderers.set(nextRendererId, renderer);
      attachRenderer(renderer);
      raw.setTimeout(start, 0);
      return nextRendererId;
    },
    onCommitFiberRoot: function (rendererId, root) {
      safeCommit(root);
    },
    onCommitFiberUnmount: function (rendererId, fiber) {
      safeUnmount(fiber);
    },
    onPostCommitFiberRoot: function () {},
    checkDCE: function () {}
  };
}

// ---------- Samples ----------

function memorySample() {
  var result = { domNodes: null, heapMb: null };
  try {
    result.domNodes = document.getElementsByTagName('*').length;
  } catch (error) {
    result.domNodes = null;
  }
  var memory = performance.memory; // Chromium only
  if (memory && memory.usedJSHeapSize) result.heapMb = Math.round(memory.usedJSHeapSize / 104857.6) / 10;
  return result;
}

function topEntries(map, limit, sortKey) {
  return Array.from(map.values())
    .sort(function (a, b) {
      return b[sortKey] - a[sortKey];
    })
    .slice(0, limit);
}

function snapshot() {
  var window_ = current;
  current = createWindow();
  tracker.tick();
  var hidden = document.visibilityState === 'hidden';
  if (!pageLoad) pageLoad = readPageLoad();
  var vitals = {
    cls: round(window_.clsValue * 1000) / 1000,
    shifts: window_.shifts.slice(0, 5),
    interactions: topEntries(window_.interactions, 5, 'ms')
  };
  if (lcp && lcp !== lcpSent) {
    vitals.lcp = lcp;
    lcpSent = lcp;
  }
  if (pageLoad && !pageLoad.sent) {
    vitals.pageLoad = pageLoad;
    pageLoad.sent = true;
  }
  return {
    t: Date.now(),
    screen: currentScreen(),
    path: locationPath(),
    routePath: [{ name: locationPath() }],
    hidden: hidden,
    commits: window_.commits,
    commitMs: round(window_.commitMs),
    slowCommits: window_.slowCommits.slice(0, 10),
    triggers: topEntries(window_.triggers, 20, 'commits').map(function (entry) {
      return Object.assign({}, entry, { ms: round(entry.ms) });
    }),
    // A hidden tab gets no frames and throttled timers: those numbers would be noise.
    jsFps: hidden ? null : window_.frames,
    longTasks: hidden ? 0 : window_.longTasks,
    longTaskMs: hidden ? 0 : round(window_.longTaskMs),
    maxBlockMs: hidden ? 0 : round(window_.maxBlockMs),
    screens: Object.fromEntries(Array.from(window_.screens.entries()).map(function (pair) { return [pair[0], round(pair[1])]; })),
    components: Array.from(window_.components.values())
      .sort(function (a, b) {
        return b.selfMs - a.selfMs;
      })
      .slice(0, 80)
      .map(function (entry) {
        return Object.assign({}, entry, {
          selfMs: round(entry.selfMs),
          libraryMs: round(entry.libraryMs),
          library: Object.fromEntries(
            Object.entries(entry.library)
              .sort(function (a, b) {
                return b[1] - a[1];
              })
              .slice(0, 4)
              .map(function (pair) {
                return [pair[0], round(pair[1])];
              })
          )
        });
      }),
    network: topEntries(window_.network, 40, 'count').map(function (entry) {
      return Object.assign({}, entry, { ms: round(entry.ms) });
    }),
    sockets: topEntries(window_.sockets, 40, 'messages').map(function (entry) {
      return Object.assign({}, entry, { bytes: Math.round(entry.bytes), sentBytes: Math.round(entry.sentBytes), renders: round(entry.renders), renderMs: round(entry.renderMs) });
    }),
    socketConnections: Array.from(window_.socketConnections.values()),
    redux: {
      dispatches: window_.store.dispatches,
      noops: window_.store.noops,
      slices: Object.fromEntries(window_.store.slices),
      actions: Array.from(window_.actions.values())
        .filter(function (entry) {
          return entry.type.indexOf('slice:') !== 0;
        })
        .map(function (entry) {
          return { type: entry.type, count: entry.count, ms: round(entry.ms) };
        }),
      sliceRenders: Array.from(window_.actions.values())
        .filter(function (entry) {
          return entry.type.indexOf('slice:') === 0;
        })
        .map(function (entry) {
          return { slice: entry.type.slice(6), commits: entry.commits, renders: round(entry.renders), renderMs: round(entry.renderMs) };
        })
    },
    web: {
      memory: memorySample(),
      vitals: vitals,
      loafs: window_.loafs.sort(function (a, b) { return b.ms - a.ms; }).slice(0, 5),
      forcedLayouts: topEntries(window_.forcedLayouts, 10, 'ms').map(function (entry) {
        return Object.assign({}, entry, { ms: round(entry.ms), maxMs: round(entry.maxMs) });
      })
    },
    leaks: tracker.snapshot(),
    probeErrors: window_.probeErrors || 0
  };
}

// ---------- Transport ----------

function clientName() {
  var ua = navigator.userAgent;
  var match;
  var browser = 'Browser';
  if ((match = /Edg(?:A|iOS)?\/(\d+)/.exec(ua))) browser = 'Edge ' + match[1];
  else if ((match = /CriOS\/(\d+)/.exec(ua))) browser = 'Chrome ' + match[1];
  else if ((match = /FxiOS\/(\d+)/.exec(ua)) || (match = /Firefox\/(\d+)/.exec(ua))) browser = 'Firefox ' + match[1];
  else if ((match = /SamsungBrowser\/(\d+)/.exec(ua))) browser = 'Samsung Internet ' + match[1];
  else if ((match = /Chrome\/(\d+)/.exec(ua))) browser = 'Chrome ' + match[1];
  else if ((match = /Version\/(\d+)[\d.]* .*Safari/.exec(ua))) browser = 'Safari ' + match[1];
  var device = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Macintosh/.test(ua)
          ? 'Mac'
          : /Windows/.test(ua)
            ? 'Windows'
            : /Linux/.test(ua)
              ? 'Linux'
              : 'device';
  return { browser: browser, device: device, viewport: window.innerWidth + '×' + window.innerHeight, dpr: window.devicePixelRatio || 1 };
}

var client = null;

function body(batch, inspect) {
  if (!client) client = clientName();
  return JSON.stringify({ platform: 'web', sessionId: sessionId, build: build, client: client, samples: batch, inspect: inspect });
}

// A path, or the dashboard's route path [{ name }] (the web probe reports its path as the name).
function navigate(path) {
  if (Array.isArray(path)) path = path.length ? path[path.length - 1].name : null;
  if (typeof path !== 'string' || !path) return false;
  if (locationPath() === path) return true;
  // A new history entry like the router's own (React Router keeps { usr, key, idx } in it).
  var state = history.state && typeof history.state === 'object' ? Object.assign({}, history.state) : null;
  if (state) {
    if ('key' in state) state.key = Math.random().toString(36).slice(2, 10);
    if (typeof state.idx === 'number') state.idx += 1;
    if ('usr' in state) state.usr = null;
  }
  history.pushState(state, '', path);
  // Routers (React Router's BrowserRouter, data routers) follow the location on popstate.
  window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
  return true;
}

function flush() {
  pending.push(snapshot());
  if (pending.length > MAX_BUFFERED) pending.splice(0, pending.length - MAX_BUFFERED);
  var batch = pending.splice(0, pending.length);
  // Inspected bodies are for watching live: lost with a failed post, never resent.
  var inspect = inspecting ? takeInspected() : undefined;
  var controller = typeof AbortController === 'function' ? new AbortController() : null;
  var timer = controller ? raw.setTimeout(function () { controller.abort(); }, 3000) : null;
  fetch(ENDPOINT + '/js', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body(batch, inspect),
    signal: controller ? controller.signal : undefined
  })
    .then(function (response) {
      return response.json().catch(function () {
        return null;
      });
    })
    .then(function (reply) {
      if (reply && reply.command && reply.command.type === 'navigate') navigate(reply.command.path);
      if (reply) setInspecting(reply.inspect === true);
      if (reply && reply.layoutReads === 'chrome') uninstallLayoutReads();
      else if (reply && reply.layoutReads === 'probe') installLayoutReads();
    })
    .catch(function () {
      Array.prototype.unshift.apply(pending, batch);
    })
    .then(function () {
      if (timer) raw.clearTimeout(timer);
    });
}

function start() {
  if (started) return;
  started = true;

  // Timer drift: browsers without the Long Tasks API (Safari, Firefox).
  if (!hasLongTaskApi) {
    var expected = performance.now() + LAG_INTERVAL_MS;
    raw.setInterval(function perfProbe_lag() {
      var nowMs = performance.now();
      var blocked = nowMs - expected;
      expected = nowMs + LAG_INTERVAL_MS;
      if (document.visibilityState === 'hidden') return;
      if (blocked > current.maxBlockMs) current.maxBlockMs = blocked;
      if (blocked >= LONG_TASK_MS) {
        current.longTasks += 1;
        current.longTaskMs += blocked;
      }
    }, LAG_INTERVAL_MS);
  }

  var onFrame = function perfProbe_frame() {
    current.frames += 1;
    raw.requestAnimationFrame(onFrame);
  };
  raw.requestAnimationFrame(onFrame);
  raw.setInterval(flush, FLUSH_MS);
  // The last second before the page goes away.
  raw.addEventListener.call(window, 'pagehide', function perfProbe_pagehide() {
    try {
      pending.push(snapshot());
      navigator.sendBeacon(ENDPOINT + '/js', new Blob([body(pending.splice(0, pending.length))], { type: 'application/json' }));
    } catch (error) {
      // best effort
    }
  });
}

// The probe's own observers exist before the tracker wraps PerformanceObserver.
installTimingObservers();
installNetworkHooks();
installSocketHook();
installLayoutReads();
tracker.installWeb(window);
installHook();

window.__perfProbe = { sessionId: sessionId, navigate: navigate, build: build };
