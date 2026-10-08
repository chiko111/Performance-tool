/* eslint-disable no-undef */
// Resource tracker for memory leaks, shared by the React Native probe (perfProbe.js) and the web probe
// (webProbe.js). Bundled only into probe builds made by `perf`.
//
// It wraps the APIs that keep something alive until they are undone — event listeners, intervals,
// long timeouts, animation-frame loops, observers, sockets, store / emitter subscriptions — and
// remembers which component created each one. The owner comes from the effect that is running: the
// probe tells the tracker when a component's effect (or its cleanup) starts and stops. When that
// component unmounts, everything it created and did not undo within a short grace period (React runs
// passive cleanups after the commit) is a leak, reported with the component, what it is and where it
// was created.
//
// Functions are named perfTracked_* so call-site stacks can skip the tracker's own frames, also in
// minified builds (probe builds keep function names).

var LEAK_GRACE_MS = 1500;
var MAX_LIVE = 20000;
var MAX_STACKS_PER_SECOND = 300;
var LONG_TIMEOUT_MS = 1000;
var MAX_UNMOUNTED_REMEMBERED = 50000;
var STACK_FRAMES = 4;

var KINDS = ['listener', 'interval', 'timeout', 'raf', 'observer', 'socket', 'subscription'];
// The tracker's own frames: its wrappers, its helpers (V8 "at name (", JavaScriptCore "name@") and,
// on the web, anything in the probe script itself.
var OWN_FRAME = /perfTracked|\/__perf\/probe\.js|leakTracker|^at (?:callSite|track|markLeaked|noteRemoveMiss) \(|^(?:callSite|track|markLeaked|noteRemoveMiss)@/;

function emptyCounts() {
  var counts = {};
  for (var index = 0; index < KINDS.length; index += 1) counts[KINDS[index]] = 0;
  return counts;
}

function createLeakTracker(options) {
  var ownComponents = (options && options.ownComponents) || new Set();
  var normalizeName = (options && options.normalizeName) || function (name) { return name; };
  var now = (options && options.now) || Date.now;
  var hasWeakRef = typeof WeakRef === 'function';

  var currentOwner = null;
  var nextRecordId = 1;
  var live = new Map(); // record id -> record
  var byOwner = new Map(); // owner id -> Set of records
  var unmounted = new Map(); // owner id -> unmount time (insertion ordered, pruned)
  var pendingChecks = []; // { ownerId, due }
  var leaks = new Map(); // leak key -> aggregate
  var removeMisses = new Map(); // key -> aggregate
  var windowCounts = { created: emptyCounts(), removed: emptyCounts() };
  var stacksThisSecond = 0;
  var stackSecond = 0;
  var droppedRecords = 0;
  var lastReportKey = '';
  var lastFullReportAt = 0;

  // ---------- owner ----------

  function owner() {
    return currentOwner;
  }

  // Runs fn with `nextOwner` as the creator of whatever fn sets up; restores the previous owner.
  function runAs(nextOwner, fn, self, args) {
    var previous = currentOwner;
    currentOwner = nextOwner;
    try {
      return fn.apply(self, args || []);
    } finally {
      currentOwner = previous;
    }
  }

  function setOwner(nextOwner) {
    var previous = currentOwner;
    currentOwner = nextOwner;
    return previous;
  }

  // ---------- call sites ----------

  function callSite() {
    var second = Math.floor(now() / 1000);
    if (second !== stackSecond) {
      stackSecond = second;
      stacksThisSecond = 0;
    }
    if (stacksThisSecond >= MAX_STACKS_PER_SECOND) return null;
    stacksThisSecond += 1;
    var stack;
    try {
      stack = new Error().stack;
    } catch (error) {
      return null;
    }
    if (!stack) return null;
    var frames = [];
    var lines = String(stack).split('\n');
    for (var index = 0; index < lines.length && frames.length < STACK_FRAMES; index += 1) {
      var line = lines[index].trim();
      if (!line || line === 'Error' || OWN_FRAME.test(line)) continue;
      frames.push(line.length > 300 ? line.slice(0, 300) : line);
    }
    return frames.length ? frames.join('\n') : null;
  }

  // ---------- records ----------

  function weak(value) {
    if (value == null || typeof value !== 'object' && typeof value !== 'function') return null;
    return hasWeakRef ? new WeakRef(value) : null;
  }

  function track(kind, detail, target, extra) {
    var creator = currentOwner;
    if (live.size >= MAX_LIVE) {
      droppedRecords += 1;
      return null;
    }
    var record = {
      id: nextRecordId,
      kind: kind,
      detail: detail,
      owner: creator,
      site: callSite(),
      at: now(),
      target: weak(target),
      global: Boolean(extra && extra.global),
      leakKey: null
    };
    nextRecordId += 1;
    live.set(record.id, record);
    windowCounts.created[kind] += 1;
    if (creator) {
      var set = byOwner.get(creator.id);
      if (!set) byOwner.set(creator.id, (set = new Set()));
      set.add(record);
      // Created by a component that is already gone (a loop or timer that keeps re-arming itself).
      if (unmounted.has(creator.id)) markLeaked(record);
    }
    return record;
  }

  function untrack(record) {
    if (!record || !live.has(record.id)) return;
    live.delete(record.id);
    windowCounts.removed[record.kind] += 1;
    if (record.owner) {
      var set = byOwner.get(record.owner.id);
      if (set) {
        set.delete(record);
        if (!set.size) byOwner.delete(record.owner.id);
      }
    }
    if (record.leakKey) {
      var leak = leaks.get(record.leakKey);
      if (leak) leak.live = Math.max(0, leak.live - 1);
    }
  }

  function firstFrame(site) {
    return site ? site.split('\n')[0] : '';
  }

  function markLeaked(record) {
    if (record.leakKey) return;
    var creator = record.owner;
    var key = [creator ? creator.name : '(unknown)', record.kind, record.detail, firstFrame(record.site)].join('\u0000');
    var leak = leaks.get(key);
    if (!leak) {
      leak = {
        component: creator ? creator.name : null,
        own: Boolean(creator && creator.own),
        kind: record.kind,
        detail: record.detail,
        site: record.site,
        live: 0,
        total: 0,
        firstAt: now(),
        lastAt: 0
      };
      leaks.set(key, leak);
    }
    leak.live += 1;
    leak.total += 1;
    leak.lastAt = now();
    record.leakKey = key;
  }

  // A listener on an element that left the page dies with the element, and one on a request or
  // signal dies with it; only listeners on the page's globals or on elements still in the page keep
  // the component's closure alive.
  function stillHolds(record) {
    if (record.kind !== 'listener' || record.global) return true;
    if (!record.target) return false;
    var target = record.target.deref();
    return Boolean(target) && target.isConnected === true;
  }

  function ownerUnmounted(ownerId) {
    if (ownerId == null) return;
    unmounted.set(ownerId, now());
    if (unmounted.size > MAX_UNMOUNTED_REMEMBERED) {
      var oldest = unmounted.keys().next().value;
      unmounted.delete(oldest);
    }
    pendingChecks.push({ ownerId: ownerId, due: now() + LEAK_GRACE_MS });
  }

  // Called once per second by the probe: settles the unmount checks that are due and drops records
  // whose target was garbage collected.
  function tick() {
    var time = now();
    var remaining = [];
    for (var index = 0; index < pendingChecks.length; index += 1) {
      var check = pendingChecks[index];
      if (check.due > time) {
        remaining.push(check);
        continue;
      }
      var set = byOwner.get(check.ownerId);
      if (set) {
        set.forEach(function (record) {
          if (stillHolds(record)) markLeaked(record);
        });
      }
      // Its cleanups have run by now; a timer of it that fires later still finds it by id.
      owners.delete(check.ownerId);
    }
    pendingChecks = remaining;
    if (hasWeakRef) {
      live.forEach(function (record) {
        if (record.target && !record.target.deref()) untrack(record);
      });
    }
  }

  // ---------- reports ----------

  function siteGroups() {
    var groups = new Map();
    live.forEach(function (record) {
      var key = [record.kind, record.detail, record.owner ? record.owner.name : '', firstFrame(record.site)].join('\u0000');
      var group = groups.get(key);
      if (!group) {
        group = {
          kind: record.kind,
          detail: record.detail,
          component: record.owner ? record.owner.name : null,
          own: Boolean(record.owner && record.owner.own),
          site: record.site,
          count: 0,
          oldestMs: 0
        };
        groups.set(key, group);
      }
      group.count += 1;
      group.oldestMs = Math.max(group.oldestMs, now() - record.at);
    });
    return Array.from(groups.values())
      .sort(function (a, b) {
        return b.count - a.count;
      })
      .slice(0, 30);
  }

  // Counts every second; the lists (leaks, the biggest live groups) only when they changed or every
  // 10 s, so long recordings stay small.
  function snapshot() {
    var liveCounts = emptyCounts();
    live.forEach(function (record) {
      liveCounts[record.kind] += 1;
    });
    var result = {
      live: liveCounts,
      created: windowCounts.created,
      removed: windowCounts.removed,
      dropped: droppedRecords
    };
    windowCounts = { created: emptyCounts(), removed: emptyCounts() };
    // Settled leaks are forgotten after 10 minutes, so the map stays as small as the live problems.
    leaks.forEach(function (leak, key) {
      if (leak.live === 0 && now() - leak.lastAt >= 600000) leaks.delete(key);
    });
    if (removeMisses.size > 200) removeMisses.clear();
    var leakList = Array.from(leaks.values())
      .sort(function (a, b) {
        return b.live - a.live || b.total - a.total;
      })
      .slice(0, 40);
    var misses = Array.from(removeMisses.values())
      .sort(function (a, b) {
        return b.count - a.count;
      })
      .slice(0, 20);
    var reportKey = JSON.stringify([leakList, misses.map(function (miss) { return miss.count; })]);
    if (reportKey !== lastReportKey || now() - lastFullReportAt > 10000) {
      lastReportKey = reportKey;
      lastFullReportAt = now();
      result.leaks = leakList;
      result.removeMisses = misses;
      result.groups = siteGroups();
    }
    return result;
  }

  // ---------- installers: shared ----------

  function describeDelay(ms) {
    var value = Number(ms) || 0;
    return value >= 1000 ? Math.round(value / 100) / 10 + ' s' : value + ' ms';
  }

  // Timer callbacks run as the owner that scheduled them, so what they set up is attributed too.
  function ownedCallback(callback, creator, onRun) {
    return function perfTracked_timerCallback() {
      if (onRun) onRun();
      var previous = currentOwner;
      currentOwner = creator;
      try {
        return callback.apply(this, arguments);
      } finally {
        currentOwner = previous;
      }
    };
  }

  function installTimers(host) {
    var timeouts = new Map(); // timer id -> record
    var intervals = new Map();
    var frames = new Map();
    var originalSetTimeout = host.setTimeout;
    var originalClearTimeout = host.clearTimeout;
    var originalSetInterval = host.setInterval;
    var originalClearInterval = host.clearInterval;
    var originalRaf = host.requestAnimationFrame;
    var originalCancelRaf = host.cancelAnimationFrame;

    if (typeof originalSetTimeout === 'function') {
      host.setTimeout = function perfTracked_setTimeout(callback, delay) {
        var creator = currentOwner;
        if (typeof callback !== 'function' || !creator || !(Number(delay) >= LONG_TIMEOUT_MS)) {
          return originalSetTimeout.apply(host, arguments);
        }
        var record = null;
        var id;
        var args = Array.prototype.slice.call(arguments);
        args[0] = ownedCallback(callback, creator, function () {
          timeouts.delete(id);
          untrack(record);
        });
        id = originalSetTimeout.apply(host, args);
        record = track('timeout', 'after ' + describeDelay(delay));
        if (record) timeouts.set(id, record);
        return id;
      };
    }
    if (typeof originalClearTimeout === 'function') {
      host.clearTimeout = function perfTracked_clearTimeout(id) {
        var record = timeouts.get(id);
        if (record) {
          timeouts.delete(id);
          untrack(record);
        }
        return originalClearTimeout.apply(host, arguments);
      };
    }
    if (typeof originalSetInterval === 'function') {
      // Every interval is tracked (they are few and each one lives until cleared).
      host.setInterval = function perfTracked_setInterval(callback, delay) {
        if (typeof callback !== 'function') return originalSetInterval.apply(host, arguments);
        var args = Array.prototype.slice.call(arguments);
        var creator = currentOwner;
        if (creator) args[0] = ownedCallback(callback, creator, null);
        var id = originalSetInterval.apply(host, args);
        var record = track('interval', 'every ' + describeDelay(delay));
        if (record) intervals.set(id, record);
        return id;
      };
    }
    if (typeof originalClearInterval === 'function') {
      host.clearInterval = function perfTracked_clearInterval(id) {
        var record = intervals.get(id);
        if (record) {
          intervals.delete(id);
          untrack(record);
        }
        return originalClearInterval.apply(host, arguments);
      };
    }
    if (typeof originalRaf === 'function') {
      // Only frames requested by a component: a loop that keeps re-requesting itself after the
      // component unmounted shows up as a live leak.
      host.requestAnimationFrame = function perfTracked_requestAnimationFrame(callback) {
        var creator = currentOwner;
        if (typeof callback !== 'function' || !creator) return originalRaf.apply(host, arguments);
        var record = null;
        var id;
        id = originalRaf.call(
          host,
          ownedCallback(callback, creator, function () {
            frames.delete(id);
            untrack(record);
          })
        );
        record = track('raf', 'animation frame');
        if (record) frames.set(id, record);
        return id;
      };
    }
    if (typeof originalCancelRaf === 'function') {
      host.cancelAnimationFrame = function perfTracked_cancelAnimationFrame(id) {
        var record = frames.get(id);
        if (record) {
          frames.delete(id);
          untrack(record);
        }
        return originalCancelRaf.apply(host, arguments);
      };
    }
  }

  // ---------- installers: web ----------

  function elementLabel(element) {
    var label = String(element.tagName || 'element').toLowerCase();
    if (element.id) label += '#' + element.id;
    var className = typeof element.className === 'string' ? element.className.trim().split(/\s+/)[0] : '';
    if (className) label += '.' + className;
    return label.length > 60 ? label.slice(0, 60) : label;
  }

  function installWeb(win) {
    installTimers(win);
    var doc = win.document;
    var EventTargetClass = win.EventTarget;
    if (EventTargetClass && EventTargetClass.prototype && EventTargetClass.prototype.addEventListener) {
      installEventTarget(win, doc, EventTargetClass.prototype);
    }
    ['IntersectionObserver', 'ResizeObserver', 'MutationObserver', 'PerformanceObserver'].forEach(function (name) {
      installObserver(win, name);
    });
    ['WebSocket', 'EventSource', 'BroadcastChannel'].forEach(function (name) {
      installConnection(win, name);
    });
  }

  function installEventTarget(win, doc, proto) {
    var add = proto.addEventListener;
    var remove = proto.removeEventListener;
    var listeners = new WeakMap(); // target -> Map(type -> [{ listener, capture, record }])

    function isGlobal(target) {
      return (
        target === win ||
        target === doc ||
        (doc && (target === doc.body || target === doc.documentElement)) ||
        (win.visualViewport && target === win.visualViewport) ||
        (win.screen && win.screen.orientation && target === win.screen.orientation) ||
        (typeof win.MediaQueryList === 'function' && target instanceof win.MediaQueryList)
      );
    }

    function label(target) {
      if (target === win) return 'window';
      if (target === doc) return 'document';
      if (doc && target === doc.body) return 'body';
      if (doc && target === doc.documentElement) return 'html';
      if (win.visualViewport && target === win.visualViewport) return 'visualViewport';
      if (typeof win.MediaQueryList === 'function' && target instanceof win.MediaQueryList) return 'matchMedia(' + target.media + ')';
      if (typeof win.Element === 'function' && target instanceof win.Element) return elementLabel(target);
      var name = target && target.constructor && target.constructor.name;
      return name || 'EventTarget';
    }

    function captureOf(options) {
      return typeof options === 'boolean' ? options : Boolean(options && options.capture);
    }

    proto.addEventListener = function perfTracked_addEventListener(type, listener, options) {
      var result = add.apply(this, arguments);
      try {
        if (!listener || (typeof options === 'object' && options && options.once)) return result;
        var global = isGlobal(this);
        // Elements: only listeners a component adds (React's own root listeners have no owner).
        if (!global && !currentOwner) return result;
        var capture = captureOf(options);
        var byType = listeners.get(this);
        if (!byType) listeners.set(this, (byType = new Map()));
        var entries = byType.get(type);
        if (!entries) byType.set(type, (entries = []));
        for (var index = 0; index < entries.length; index += 1) {
          if (entries[index].listener === listener && entries[index].capture === capture) return result; // the browser ignores duplicates
        }
        var record = track('listener', label(this) + ' ' + type, this, { global: global });
        if (!record) return result;
        var entry = { listener: listener, capture: capture, record: record };
        entries.push(entry);
        var signal = typeof options === 'object' && options ? options.signal : null;
        if (signal && typeof signal.addEventListener === 'function') {
          add.call(signal, 'abort', function perfTracked_abort() {
            var position = entries.indexOf(entry);
            if (position !== -1) entries.splice(position, 1);
            untrack(record);
          });
        }
      } catch (error) {
        // never break the app
      }
      return result;
    };

    proto.removeEventListener = function perfTracked_removeEventListener(type, listener, options) {
      try {
        var byType = listeners.get(this);
        var entries = byType && byType.get(type);
        if (entries && entries.length) {
          var capture = captureOf(options);
          var found = -1;
          for (var index = 0; index < entries.length; index += 1) {
            if (entries[index].listener === listener && entries[index].capture === capture) {
              found = index;
              break;
            }
          }
          if (found !== -1) {
            untrack(entries[found].record);
            entries.splice(found, 1);
          } else if (currentOwner) {
            // The same component removes a listener of this type here, but nothing matches: a new
            // function (inline arrow, .bind) or a different capture flag. The original stays.
            for (var other = 0; other < entries.length; other += 1) {
              var record = entries[other].record;
              if (record.owner && record.owner.id === currentOwner.id) {
                noteRemoveMiss(record, entries[other].capture !== capture);
                break;
              }
            }
          }
        }
      } catch (error) {
        // never break the app
      }
      return remove.apply(this, arguments);
    };
  }

  function noteRemoveMiss(record, captureDiffers) {
    var key = [record.owner.name, record.detail, firstFrame(record.site)].join('\u0000');
    var miss = removeMisses.get(key);
    if (!miss) {
      miss = {
        component: record.owner.name,
        own: Boolean(record.owner.own),
        detail: record.detail,
        site: record.site,
        removeSite: callSite(),
        reason: captureDiffers ? 'capture flag differs' : 'different function',
        count: 0
      };
      removeMisses.set(key, miss);
    }
    miss.count += 1;
  }

  function installObserver(win, name) {
    var Original = win[name];
    if (typeof Original !== 'function' || !hasWeakRef) return;
    var records = new WeakMap(); // observer -> record
    function Tracked(callback, options) {
      var instance = Reflect.construct(Original, [callback, options], Tracked);
      var record = track('observer', name);
      if (record) {
        record.target = new WeakRef(instance);
        record.global = true;
        records.set(instance, record);
      }
      return instance;
    }
    Tracked.prototype = Original.prototype;
    Object.setPrototypeOf(Tracked, Original);
    var disconnect = Original.prototype.disconnect;
    if (typeof disconnect === 'function') {
      Original.prototype.disconnect = function perfTracked_disconnect() {
        untrack(records.get(this));
        return disconnect.apply(this, arguments);
      };
    }
    try {
      Object.defineProperty(Tracked, 'name', { value: name });
    } catch (error) {
      // older engines
    }
    win[name] = Tracked;
  }

  function installConnection(win, name) {
    var Original = win[name];
    if (typeof Original !== 'function' || !hasWeakRef) return;
    var records = new WeakMap();
    function Tracked(first, second) {
      var instance = Reflect.construct(Original, Array.prototype.slice.call(arguments), Tracked);
      var where = '';
      try {
        where = name === 'BroadcastChannel' ? String(first) : new URL(String(first), win.location.href).host;
      } catch (error) {
        where = '';
      }
      var record = track('socket', name + (where ? ' ' + where : ''));
      if (record) {
        record.target = new WeakRef(instance);
        record.global = true;
        records.set(instance, record);
        if (name !== 'BroadcastChannel' && typeof instance.addEventListener === 'function') {
          // A server-side close also ends it; the tracker's own listener carries no owner.
          var previous = currentOwner;
          currentOwner = null;
          try {
            instance.addEventListener('close', function perfTracked_closed() {
              untrack(record);
            });
          } finally {
            currentOwner = previous;
          }
        }
      }
      return instance;
    }
    Tracked.prototype = Original.prototype;
    Object.setPrototypeOf(Tracked, Original);
    var close = Original.prototype.close;
    if (typeof close === 'function') {
      Original.prototype.close = function perfTracked_close() {
        untrack(records.get(this));
        return close.apply(this, arguments);
      };
    }
    try {
      Object.defineProperty(Tracked, 'name', { value: name });
    } catch (error) {
      // older engines
    }
    win[name] = Tracked;
  }

  // ---------- installers: subscriptions ----------

  // A subscribe-like method that returns an unsubscribe function (Redux store.subscribe).
  function wrapSubscribe(object, method, label) {
    var original = object && object[method];
    if (typeof original !== 'function' || original.__perfTracked) return;
    var wrapped = function perfTracked_subscribe() {
      var unsubscribe = original.apply(this, arguments);
      if (typeof unsubscribe !== 'function') return unsubscribe;
      var record = track('subscription', label);
      return function perfTracked_unsubscribe() {
        untrack(record);
        return unsubscribe.apply(this, arguments);
      };
    };
    wrapped.__perfTracked = true;
    object[method] = wrapped;
  }

  // An addListener-like method that returns a subscription with remove() (React Native emitters).
  // Module APIs (Keyboard, AppState…) use a NativeEventEmitter inside: only the outermost call counts.
  var emitterDepth = 0;
  function wrapEmitter(object, method, label) {
    var original = object && object[method];
    if (typeof original !== 'function' || original.__perfTracked) return;
    var wrapped = function perfTracked_addListener(type) {
      if (emitterDepth > 0) return original.apply(this, arguments);
      var subscription;
      emitterDepth += 1;
      try {
        subscription = original.apply(this, arguments);
      } finally {
        emitterDepth -= 1;
      }
      if (!subscription || typeof subscription.remove !== 'function') return subscription;
      var record = track('subscription', label + ' ' + String(type));
      if (!record) return subscription;
      var remove = subscription.remove;
      try {
        subscription.remove = function perfTracked_remove() {
          untrack(record);
          return remove.apply(this, arguments);
        };
      } catch (error) {
        untrack(record); // a frozen subscription cannot be followed: do not report it as a leak
      }
      return subscription;
    };
    wrapped.__perfTracked = true;
    try {
      object[method] = wrapped;
    } catch (error) {
      // read-only module export
    }
  }

  // ---------- React integration ----------

  var COMPONENT_TAGS = { 0: true, 1: true, 11: true, 14: true, 15: true };
  var EFFECT_TAGS = { 0: true, 11: true, 15: true }; // function components keep effects on updateQueue
  var PASSIVE_FLAG = 2048; // fiber flag Passive (React 18 / 19)
  var HOOK_HAS_EFFECT = 1;
  var HOOK_PASSIVE = 8;
  var instanceIds = new WeakMap();
  var owners = new Map(); // instance id -> owner
  var nextInstanceId = 1;
  var wrappedCreates = new WeakSet();

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

  // One owner per mounted component instance; a fiber and its alternate are the same instance.
  function ownerOf(fiber) {
    if (!fiber || !COMPONENT_TAGS[fiber.tag]) return null;
    var id = instanceIds.get(fiber) || (fiber.alternate && instanceIds.get(fiber.alternate));
    if (!id) {
      id = nextInstanceId;
      nextInstanceId += 1;
      instanceIds.set(fiber, id);
      if (fiber.alternate) instanceIds.set(fiber.alternate, id);
      var name = normalizeName(componentName(fiber) || 'Anonymous');
      owners.set(id, { id: id, name: name, own: ownComponents.has(name) });
    } else if (!instanceIds.has(fiber)) {
      instanceIds.set(fiber, id);
    }
    return owners.get(id);
  }

  // React reports the unmount before it runs the component's passive cleanups, which still need
  // the owner (a cleanup that removes nothing is noticed that way): the owner is dropped by tick().
  function fiberUnmounted(fiber) {
    if (!fiber) return;
    var id = instanceIds.get(fiber) || (fiber.alternate && instanceIds.get(fiber.alternate));
    if (!id || unmounted.has(id)) return;
    ownerUnmounted(id);
  }

  // React DOM's profiling build reports when a component's effects (and their cleanups) start and
  // stop: everything set up in between belongs to that component. Layout effects included.
  function profilingHooks() {
    var stack = [];
    function start(fiber) {
      stack.push(currentOwner);
      currentOwner = ownerOf(fiber);
    }
    function stop() {
      currentOwner = stack.length ? stack.pop() : null;
    }
    return {
      markComponentPassiveEffectMountStarted: start,
      markComponentPassiveEffectMountStopped: stop,
      markComponentLayoutEffectMountStarted: start,
      markComponentLayoutEffectMountStopped: stop,
      markComponentPassiveEffectUnmountStarted: start,
      markComponentPassiveEffectUnmountStopped: stop,
      markComponentLayoutEffectUnmountStarted: start,
      markComponentLayoutEffectUnmountStopped: stop
    };
  }

  // Renderers without those hooks (React Native): called from onCommitFiberRoot, which runs before
  // React flushes the commit's passive effects. Each pending useEffect callback is wrapped so it runs
  // as its component. React stores create() as given and only calls it, so the wrapper is invisible.
  function wrapPendingEffects(rootFiber) {
    if (!rootFiber) return;
    var stack = [rootFiber];
    while (stack.length) {
      var fiber = stack.pop();
      if (fiber.flags & PASSIVE_FLAG && EFFECT_TAGS[fiber.tag] && fiber.updateQueue && fiber.updateQueue.lastEffect) {
        var first = fiber.updateQueue.lastEffect.next;
        var effect = first;
        var creator = null;
        do {
          var pending = (effect.tag & (HOOK_HAS_EFFECT | HOOK_PASSIVE)) === (HOOK_HAS_EFFECT | HOOK_PASSIVE);
          if (pending && typeof effect.create === 'function' && !wrappedCreates.has(effect.create)) {
            creator = creator || ownerOf(fiber);
            effect.create = ownedEffect(effect.create, creator);
          }
          effect = effect.next;
        } while (effect && effect !== first);
      }
      for (var child = fiber.child; child !== null && child !== undefined; child = child.sibling) {
        if ((child.flags | child.subtreeFlags) & PASSIVE_FLAG) stack.push(child);
      }
    }
  }

  function ownedEffect(create, creator) {
    var wrapped = function perfTracked_effect() {
      var previous = currentOwner;
      currentOwner = creator;
      try {
        var destroy = create();
        if (typeof destroy !== 'function') return destroy;
        return function perfTracked_cleanup() {
          var before = currentOwner;
          currentOwner = creator;
          try {
            return destroy.apply(this, arguments);
          } finally {
            currentOwner = before;
          }
        };
      } finally {
        currentOwner = previous;
      }
    };
    wrappedCreates.add(wrapped);
    return wrapped;
  }

  return {
    owner: owner,
    runAs: runAs,
    setOwner: setOwner,
    ownerOf: ownerOf,
    fiberUnmounted: fiberUnmounted,
    profilingHooks: profilingHooks,
    wrapPendingEffects: wrapPendingEffects,
    installTimers: installTimers,
    installWeb: installWeb,
    wrapSubscribe: wrapSubscribe,
    wrapEmitter: wrapEmitter,
    tick: tick,
    snapshot: snapshot
  };
}

module.exports = { createLeakTracker: createLeakTracker };
