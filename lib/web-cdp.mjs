// Web performance over the Chrome DevTools Protocol: the browser counterpart of the Android adb
// collector in server.mjs. Finds the app's tabs on one or more debugging ports (desktop Chrome,
// Android Chrome over adb forward), samples each once per second (main/worker/GPU thread busy
// time, script/layout/style time, GC, forced layouts, heap and DOM counters) and takes heap
// snapshots for growth diffs and detached DOM.
//
// Tracing notes (measured on Chrome 154):
// - Tracing is browser-wide and only one session may trace at a time ("Tracing has already been
//   started (possibly in another tab)"), so there is one tracer per browser (port), not per tab;
//   it uses the browser target and routes events to tabs by renderer process.
// - With the Perfetto backend Tracing.dataCollected only arrives after Tracing.end, even in
//   'ReportEvents' mode. The tracer therefore records in ~1 s windows (end → restart costs about
//   50 ms, during which events are missed), and each tab's per-second sample is emitted once the
//   trace covering that second has arrived: samples run 1-2 s behind real time.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { connectWebSocket } from './cdp-websocket.mjs';
import { SnapshotParser, constructorCounts, detachedDomGroups } from './heap-snapshot.mjs';

const execFileAsync = promisify(execFile);

const POLL_MS = 2000;
const SAMPLE_MS = 1000;
const TRACE_WINDOW_MS = 1000;
const CALL_TIMEOUT_MS = 10000;
const SNAPSHOT_TIMEOUT_MS = 5 * 60 * 1000;
// A sample waits for its trace at most this long; then it goes out without trace data.
const TRACE_WAIT_MS = 5000;
const ATTACH_RETRY_MS = 10000;

// Measured: devtools.timeline gives Layout/UpdateLayoutTree/MinorGC/MajorGC and frame ids,
// toplevel gives the per-thread task events, .stack adds the JS stack to forced layouts.
// disabled-by-default-devtools.timeline and the v8 / v8.gc categories add ~50% more events
// (invalidation tracking, GC sub-phases) that nothing here reads.
const TRACE_CATEGORIES = ['devtools.timeline', 'toplevel', 'disabled-by-default-devtools.timeline.stack'];

// Outermost task events per thread; they nest (RunTask inside DoWork…), so busy time is the
// union of their intervals, not the sum.
const TASK_EVENTS = new Set([
  'ThreadControllerImpl::RunTask',
  'ThreadPool_RunTask',
  'RunTask',
  'ThreadControllerImpl::DoWork',
  'TaskQueueManager::ProcessTaskFromWorkQueue'
]);
// Tracing's own writer thread: only there because we trace.
const IGNORED_THREADS = new Set(['PerfettoTrace']);

// ---------- small helpers ----------

// `cancellers` (a Set) lets stop() cut a pending sleep short.
function sleep(ms, cancellers) {
  return new Promise(resolve => {
    const done = () => {
      clearTimeout(timer);
      cancellers?.delete(done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    cancellers?.add(done);
  });
}

// GET/PUT on the DevTools HTTP endpoint. Rejects quickly when nothing listens on the port.
function devtoolsHttp(port, pathname, { method = 'GET', timeoutMs = 1500, host = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host, port, path: pathname, method, timeout: timeoutMs }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => (body += chunk));
      response.on('end', () => {
        if (response.statusCode >= 400) {
          reject(new Error(`HTTP ${response.statusCode} for ${pathname}: ${body.trim()}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(body);
        }
      });
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error(`timed out: http://${host}:${port}${pathname}`)));
    request.on('error', reject);
    request.end();
  });
}

const round1 = value => Math.round(value * 10) / 10;

// 'ThreadPoolForegroundWorker', 'DedicatedWorker thread', 'CompositorTileWorker2' → stable names.
function foldThreadName(name) {
  return String(name)
    .replace(/ thread$/i, '')
    .replace(/[\s_#:/-]*\d+$/, '');
}

// ---------- one CDP connection ----------

// Request/response over one WebSocket; events go out as ('event', method, params).
class CdpConnection extends EventEmitter {
  static async open(url, log) {
    return new CdpConnection(await connectWebSocket(url), log);
  }

  constructor(socket, log) {
    super();
    this.socket = socket;
    this.log = log;
    this.nextId = 1;
    this.pending = new Map();
    this.open = true;
    socket.on('message', text => this.receive(text));
    socket.on('error', () => {}); // always followed by 'close'
    socket.on('close', () => {
      this.open = false;
      for (const { reject, timer, method } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error(`${method}: connection closed`));
      }
      this.pending.clear();
      this.emit('close');
    });
  }

  send(method, params = {}, { timeoutMs = CALL_TIMEOUT_MS } = {}) {
    if (!this.open) return Promise.reject(new Error(`${method}: connection closed`));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  receive(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return; // a garbled message must not take the connection down
    }
    if (message.id !== undefined) {
      const call = this.pending.get(message.id);
      if (!call) return; // answered after its timeout
      this.pending.delete(message.id);
      clearTimeout(call.timer);
      if (message.error) call.reject(new Error(`${call.method}: ${message.error.message}`));
      else call.resolve(message.result ?? {});
      return;
    }
    if (!message.method) return;
    // A throwing listener would otherwise surface as an uncaught exception in the socket handler.
    try {
      this.emit('event', message.method, message.params ?? {});
    } catch (error) {
      this.log?.(`CDP: ${message.method} handler failed: ${error.stack ?? error}`);
    }
  }

  close() {
    this.socket.close();
  }
}

// ---------- tracing, one per browser ----------

class BrowserTracer {
  constructor({ port, label, log }) {
    this.port = port;
    this.label = label;
    this.log = log;
    this.subscribers = new Set();
    this.connection = null;
    this.available = false; // true while windows are being recorded
    this.coverageUs = 0; // trace clock up to which all events have been delivered
    this.threadNames = new Map(); // `${pid}:${tid}` -> thread name (metadata repeats every window)
    this.gpuPid = null;
    this.cancel = new Set();
    this.running = false;
    this.warned = new Set();
  }

  warnOnce(key, message) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.log(message);
  }

  subscribe(target) {
    this.subscribers.add(target);
    if (!this.running) {
      this.running = true;
      this.loop().catch(error => this.log(`Tracing (${this.label}): ${error.message}`)).finally(() => (this.running = false));
    }
  }

  unsubscribe(target) {
    this.subscribers.delete(target);
    if (!this.subscribers.size) this.stop();
  }

  stop() {
    this.subscribers.clear();
    for (const cancel of [...this.cancel]) cancel();
    this.available = false;
    const connection = this.connection;
    this.connection = null;
    if (connection) {
      // Ending politely frees the browser-wide tracing slot right away.
      connection.send('Tracing.end', {}, { timeoutMs: 1000 }).catch(() => {}).finally(() => connection.close());
    }
  }

  async connect() {
    const version = await devtoolsHttp(this.port, '/json/version');
    if (!version.webSocketDebuggerUrl) throw new Error('no browser endpoint');
    const connection = await CdpConnection.open(version.webSocketDebuggerUrl, this.log);
    connection.on('event', (method, params) => {
      if (method === 'Tracing.dataCollected') this.batch.push(params.value ?? []);
      else if (method === 'Tracing.tracingComplete') this.onComplete?.();
    });
    connection.on('close', () => {
      if (this.connection === connection) {
        this.connection = null;
        this.available = false;
      }
    });
    return connection;
  }

  async loop() {
    while (this.subscribers.size) {
      try {
        if (!this.connection) this.connection = await this.connect();
        await this.recordWindow(this.connection);
      } catch (error) {
        this.available = false;
        const message = String(error.message);
        if (/connection closed/.test(message)) {
          // Browser quit or restarted: its tabs detach too; reconnect quietly if any remain.
          this.connection = null;
        } else if (/already been started/i.test(message)) {
          // DevTools' Performance panel (or another tool) is recording; try again later.
          this.warnOnce('busy', `Tracing (${this.label}): another client is tracing; GC/thread/forced-layout data paused until it stops.`);
        } else if (this.subscribers.size) {
          this.warnOnce('unavailable', `Tracing (${this.label}) unavailable (${message}); sampling metrics only.`);
          this.connection?.close();
          this.connection = null;
        }
        await sleep(10000, this.cancel);
      }
    }
  }

  async recordWindow(connection) {
    this.batch = [];
    await connection.send('Tracing.start', {
      transferMode: 'ReportEvents',
      traceConfig: { includedCategories: TRACE_CATEGORIES, excludedCategories: ['*'], recordMode: 'recordUntilFull' }
    });
    this.available = true;
    this.warned.delete('busy');
    await sleep(TRACE_WINDOW_MS, this.cancel);
    if (this.connection !== connection) return;
    const complete = new Promise(resolve => (this.onComplete = resolve));
    await connection.send('Tracing.end');
    await Promise.race([complete, sleep(5000, this.cancel)]);
    this.onComplete = null;
    this.deliver(this.batch);
    this.batch = [];
  }

  deliver(batch) {
    let latest = 0;
    for (const events of batch) {
      for (const event of events) {
        if (event.ph === 'M') {
          if (event.name === 'thread_name') this.threadNames.set(`${event.pid}:${event.tid}`, event.args?.name ?? '');
          else if (event.name === 'process_name' && event.args?.name === 'GPU Process') this.gpuPid = event.pid;
          continue;
        }
        const end = event.ts + (event.dur ?? 0);
        if (end > latest) latest = end;
      }
    }
    if (latest > this.coverageUs) this.coverageUs = latest;
    for (const target of this.subscribers) {
      try {
        target.consumeTrace(batch, this);
      } catch (error) {
        this.log(`Tracing: ${target.label} ${target.id}: ${error.stack ?? error}`);
      }
    }
  }
}

// ---------- one attached tab ----------

class PageTarget {
  constructor(hub, info, port) {
    this.hub = hub;
    this.id = info.id;
    this.port = port.port;
    this.label = port.label;
    this.url = info.url;
    this.title = info.title;
    this.wsUrl = info.webSocketDebuggerUrl;
    this.attached = false;
    this.sessionId = null;
    this.connection = null;
    this.previousMetrics = null;
    this.pending = []; // samples waiting for their second's trace
    this.trace = { tasks: [], gcs: [], layouts: [], open: new Map() };
    this.rendererPid = null;
    this.ticks = 0;
    this.busy = false;
    this.snapshotting = false;
  }

  get log() {
    return this.hub.log;
  }

  async attach() {
    const connection = await CdpConnection.open(this.wsUrl, this.log);
    this.connection = connection;
    connection.on('close', () => this.hub.detach(this.id));
    connection.on('event', (method, params) => this.onEvent(method, params));
    await connection.send('Page.enable');
    // timeTicks puts Performance.getMetrics' Timestamp on the trace clock, which is how a
    // second's metrics are matched with that second's trace events.
    await connection.send('Performance.enable', { timeDomain: 'timeTicks' }).catch(() => connection.send('Performance.enable'));
    this.attached = true;
    await this.readSessionId();
    this.timer = setInterval(() => this.tick(), SAMPLE_MS);
  }

  close() {
    this.attached = false;
    clearInterval(this.timer);
    clearTimeout(this.sessionTimer);
    this.connection?.close();
  }

  // Runtime is not enabled on purpose: Runtime.enable streams every console call and exception
  // (with object previews) to us, which costs the page time. Navigation events from Page are
  // enough to know when the probe's session can have changed.
  onEvent(method, params) {
    if (method === 'Page.frameNavigated' && !params.frame?.parentId) {
      this.url = params.frame.url;
      this.sessionId = null;
      this.scheduleSessionRead(300);
    } else if (method === 'Page.loadEventFired' || method === 'Page.domContentEventFired') {
      this.scheduleSessionRead(0);
    } else if (method === 'Inspector.targetCrashed') {
      this.log(`Web: ${this.label} tab crashed (${this.url})`);
    }
  }

  scheduleSessionRead(delayMs) {
    clearTimeout(this.sessionTimer);
    this.sessionTimer = setTimeout(() => this.readSessionId(), delayMs);
  }

  async readSessionId() {
    try {
      const value = await this.evaluate('window.__perfProbe && window.__perfProbe.sessionId', { timeoutMs: 3000 });
      this.sessionId = value == null ? null : String(value);
    } catch {
      // Page busy or navigating; the next tick or navigation event retries.
    }
  }

  async evaluate(expression, { awaitPromise = false, timeoutMs = CALL_TIMEOUT_MS } = {}) {
    const { result, exceptionDetails } = await this.connection.send(
      'Runtime.evaluate',
      { expression, awaitPromise, returnByValue: true },
      { timeoutMs }
    );
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text ?? 'evaluation failed');
    }
    return result?.value;
  }

  async metrics() {
    const { metrics } = await this.connection.send('Performance.getMetrics', {}, { timeoutMs: 3000 });
    return Object.fromEntries(metrics.map(metric => [metric.name, metric.value]));
  }

  async tick() {
    // During a heap snapshot the renderer is paused; skipping keeps calls from piling up.
    if (this.busy || this.snapshotting || !this.attached) return;
    this.busy = true;
    try {
      this.ticks += 1;
      // The probe may install itself after load (app boot); keep looking while there is none.
      if (this.sessionId === null && this.ticks % 2 === 0) await this.readSessionId();
      this.queueSample(await this.metrics());
      this.flush();
    } catch {
      // A navigation or a busy renderer; the next second tries again.
    } finally {
      this.busy = false;
    }
  }

  queueSample(current) {
    const previous = this.previousMetrics;
    this.previousMetrics = current;
    // The first reading is only a baseline. Counters going backwards mean a new renderer
    // (cross-process navigation, crash + reload): start over rather than report negative work.
    if (!previous || current.Timestamp <= previous.Timestamp || current.TaskDuration < previous.TaskDuration) return;
    const deltaMs = key => Math.max(0, round1(((current[key] ?? 0) - (previous[key] ?? 0)) * 1000));
    const delta = key => Math.max(0, (current[key] ?? 0) - (previous[key] ?? 0));
    this.pending.push({
      fromUs: previous.Timestamp * 1e6,
      toUs: current.Timestamp * 1e6,
      queuedAt: Date.now(),
      sample: {
        t: Date.now(),
        scriptMs: deltaMs('ScriptDuration'),
        layoutMs: deltaMs('LayoutDuration'),
        styleMs: deltaMs('RecalcStyleDuration'),
        taskMs: deltaMs('TaskDuration'),
        layoutCount: delta('LayoutCount'),
        styleCount: delta('RecalcStyleCount'),
        heap: { usedMb: round1((current.JSHeapUsedSize ?? 0) / 1048576), totalMb: round1((current.JSHeapTotalSize ?? 0) / 1048576) },
        nodes: current.Nodes ?? null,
        listeners: current.JSEventListeners ?? null,
        documents: current.Documents ?? null
      }
    });
  }

  // Emits queued samples whose second the trace already covers (or that waited long enough).
  flush() {
    const tracer = this.hub.tracerFor(this.port);
    while (this.pending.length) {
      const next = this.pending[0];
      const covered = tracer?.available && tracer.coverageUs >= next.toUs;
      const waitedOut = Date.now() - next.queuedAt > TRACE_WAIT_MS;
      if (tracer?.available && !covered && !waitedOut) return;
      this.pending.shift();
      const traced = this.traceSummary(next.fromUs, next.toUs, tracer);
      this.hub.emitSafe('sample', {
        targetId: this.id,
        label: this.label,
        url: this.url,
        sessionId: this.sessionId,
        sample: { ...next.sample, ...traced }
      });
    }
  }

  // Keeps only what the samples need from a trace window: task intervals of this tab's renderer
  // threads and the GPU main thread, GC events and forced layouts of the renderer.
  consumeTrace(batch, tracer) {
    for (const events of batch) {
      for (const event of events) {
        const frame = event.args?.data?.frame ?? event.args?.beginData?.frame;
        // The main frame's id is the target id; its events tell which process renders the tab.
        if (frame === this.id) this.rendererPid = event.pid;
      }
    }
    const pid = this.rendererPid;
    if (pid === null) return;
    const trace = this.trace;
    for (const events of batch) {
      for (const event of events) {
        const isGpuMain = event.pid === tracer.gpuPid && tracer.threadNames.get(`${event.pid}:${event.tid}`) === 'CrGpuMain';
        if (event.pid !== pid && !isGpuMain) continue;
        if (TASK_EVENTS.has(event.name)) this.collectTask(event);
        if (event.pid !== pid || event.ph !== 'X') continue;
        if (event.name === 'MinorGC' || event.name === 'MajorGC') {
          trace.gcs.push({ ts: event.ts, ms: (event.dur ?? 0) / 1000, major: event.name === 'MajorGC' });
        } else if (event.name === 'Layout' || event.name === 'UpdateLayoutTree') {
          // A JS stack on a layout means script forced it synchronously (offsetHeight & co).
          const stack = event.args?.beginData?.stackTrace ?? event.args?.data?.stackTrace;
          // The web probe times layout reads through its own wrappers: the app's frame is the first
          // one outside the probe script.
          const frame = stack?.find(item => !String(item.url ?? '').includes('/__perf/probe.js')) ?? stack?.[0];
          if (frame) trace.layouts.push({ ts: event.ts, ms: (event.dur ?? 0) / 1000, frame });
        }
      }
    }
    // Bound memory when samples stall (e.g. metrics failing during a long renderer pause).
    const horizon = tracer.coverageUs - 10e6;
    trace.tasks = trace.tasks.filter(task => task.end > horizon);
    trace.gcs = trace.gcs.filter(event => event.ts > horizon);
    trace.layouts = trace.layouts.filter(event => event.ts > horizon);
    this.flush();
  }

  collectTask(event) {
    const key = `${event.pid}:${event.tid}`;
    if (event.ph === 'X') {
      this.trace.tasks.push({ key, pid: event.pid, start: event.ts, end: event.ts + (event.dur ?? 0) });
    } else if (event.ph === 'B') {
      const stack = this.trace.open.get(key) ?? [];
      stack.push(event.ts);
      this.trace.open.set(key, stack);
    } else if (event.ph === 'E') {
      const start = this.trace.open.get(key)?.pop();
      if (start !== undefined) this.trace.tasks.push({ key, pid: event.pid, start, end: event.ts });
    }
  }

  // Trace-derived part of the sample for the second (fromUs, toUs] on the trace clock.
  traceSummary(fromUs, toUs, tracer) {
    const trace = this.trace;
    const busyByThread = new Map();
    for (const task of trace.tasks) {
      if (task.end <= fromUs || task.start >= toUs) continue;
      const list = busyByThread.get(task.key) ?? [];
      list.push([Math.max(task.start, fromUs), Math.min(task.end, toUs)]);
      busyByThread.set(task.key, list);
    }
    const byName = new Map();
    for (const [key, intervals] of busyByThread) {
      const pid = Number(key.split(':')[0]);
      const raw = tracer?.threadNames.get(key) ?? 'Thread';
      if (IGNORED_THREADS.has(raw)) continue;
      const name = pid === tracer?.gpuPid ? 'GPU' : foldThreadName(raw);
      byName.set(name, (byName.get(name) ?? 0) + unionLength(intervals) / 1000);
    }
    const threads = [...byName.entries()]
      .map(([name, cpuMs]) => ({ name, cpuMs: round1(cpuMs) }))
      .filter(thread => thread.cpuMs > 0)
      .sort((a, b) => b.cpuMs - a.cpuMs);

    const gc = { count: 0, ms: 0, minorCount: 0, minorMs: 0, majorCount: 0, majorMs: 0 };
    for (const event of trace.gcs) {
      if (event.ts <= fromUs || event.ts > toUs) continue;
      gc.count += 1;
      gc.ms += event.ms;
      if (event.major) {
        gc.majorCount += 1;
        gc.majorMs += event.ms;
      } else {
        gc.minorCount += 1;
        gc.minorMs += event.ms;
      }
    }
    for (const key of ['ms', 'minorMs', 'majorMs']) gc[key] = round1(gc[key]);

    const layouts = new Map();
    for (const event of trace.layouts) {
      if (event.ts <= fromUs || event.ts > toUs) continue;
      const frame = event.frame;
      const key = `${frame.url}:${frame.lineNumber}:${frame.columnNumber}:${frame.functionName}`;
      const entry = layouts.get(key) ?? {
        ms: 0,
        count: 0,
        url: frame.url ?? '',
        // Trace stack frames are 1-based (unlike Runtime.CallFrame); converted to 0-based here
        // so they match every other CDP location.
        line: Math.max(0, (frame.lineNumber ?? 1) - 1),
        column: Math.max(0, (frame.columnNumber ?? 1) - 1),
        functionName: frame.functionName || '(anonymous)'
      };
      entry.ms += event.ms;
      entry.count += 1;
      layouts.set(key, entry);
    }
    const forcedLayouts = [...layouts.values()]
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 10)
      .map(entry => ({ ...entry, ms: round1(entry.ms) }));

    // Drop what can no longer fall into a later second; long tasks still running stay.
    trace.tasks = trace.tasks.filter(task => task.end > toUs);
    trace.gcs = trace.gcs.filter(event => event.ts > toUs);
    trace.layouts = trace.layouts.filter(event => event.ts > toUs);

    const main = threads.find(thread => thread.name === 'CrRendererMain');
    return { cpu: { mainMs: main?.cpuMs ?? 0, threads }, gc, forcedLayouts };
  }

  // Streams a heap snapshot into the incremental parser; resolves with the parsed snapshot.
  async heapSnapshot(onProgress) {
    if (this.snapshotting) throw new Error('A heap snapshot of this tab is already running');
    this.snapshotting = true;
    const parser = new SnapshotParser();
    let parseError = null;
    const listener = (method, params) => {
      if (method === 'HeapProfiler.addHeapSnapshotChunk') {
        if (parseError) return;
        try {
          parser.push(params.chunk);
        } catch (error) {
          parseError = error;
        }
      } else if (method === 'HeapProfiler.reportHeapSnapshotProgress') {
        onProgress?.({ phase: 'snapshot', done: params.done, total: params.total });
      }
    };
    this.connection.on('event', listener);
    const startedAt = Date.now();
    try {
      await this.connection.send('HeapProfiler.enable');
      await this.connection.send('HeapProfiler.takeHeapSnapshot', { reportProgress: true, captureNumericValue: false }, { timeoutMs: SNAPSHOT_TIMEOUT_MS });
    } finally {
      this.connection.off('event', listener);
      this.connection.send('HeapProfiler.disable').catch(() => {});
      this.snapshotting = false;
      // Metrics taken across the pause would report the snapshot as page work.
      this.previousMetrics = null;
    }
    if (parseError) throw new Error(`Heap snapshot parse failed: ${parseError.message}`);
    const transferMs = Date.now() - startedAt;
    onProgress?.({ phase: 'parse' });
    const parseStart = Date.now();
    const snapshot = parser.finish();
    return { snapshot, bytes: parser.bytes, transferMs, parseMs: Date.now() - parseStart };
  }
}

// Total length covered by possibly overlapping [start, end] intervals.
function unionLength(intervals) {
  intervals.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [start, end] = intervals[0];
  for (let i = 1; i < intervals.length; i++) {
    const [nextStart, nextEnd] = intervals[i];
    if (nextStart > end) {
      total += end - start;
      [start, end] = [nextStart, nextEnd];
    } else if (nextEnd > end) {
      end = nextEnd;
    }
  }
  return total + (end - start);
}

// ---------- the hub ----------

export class CdpHub extends EventEmitter {
  constructor({ ports, matchUrl, log = console.log }) {
    super();
    this.ports = ports;
    this.matchUrl = matchUrl ?? (() => true);
    this.log = log;
    this.pages = new Map(); // targetId -> PageTarget (attached or attaching)
    this.failedAt = new Map(); // targetId -> time of the last failed attach
    this.tracers = new Map(); // port -> BrowserTracer
    this.timers = [];
    this.polling = new Set();
  }

  start() {
    if (this.timers.length) return;
    for (const port of this.ports) {
      this.poll(port);
      this.timers.push(setInterval(() => this.poll(port), POLL_MS));
    }
  }

  stop() {
    for (const timer of this.timers.splice(0)) clearInterval(timer);
    for (const id of [...this.pages.keys()]) this.detach(id);
    for (const tracer of this.tracers.values()) tracer.stop();
    this.tracers.clear();
  }

  setMatchUrl(fn) {
    this.matchUrl = fn;
  }

  targets() {
    return [...this.pages.values()].map(page => ({
      id: page.id,
      port: page.port,
      label: page.label,
      url: page.url,
      title: page.title,
      attached: page.attached,
      sessionId: page.sessionId
    }));
  }

  // Listener errors must not escape into timers / socket handlers.
  emitSafe(name, payload) {
    try {
      this.emit(name, payload);
    } catch (error) {
      this.log(`Web: '${name}' listener failed: ${error.stack ?? error}`);
    }
  }

  tracerFor(port) {
    return this.tracers.get(port) ?? null;
  }

  matches(url) {
    try {
      return Boolean(this.matchUrl(url));
    } catch {
      return false;
    }
  }

  async poll(port) {
    if (this.polling.has(port.port)) return;
    this.polling.add(port.port);
    try {
      let list;
      try {
        list = await devtoolsHttp(port.port, '/json/list');
      } catch {
        // Nothing listening (browser not started / closed): quiet, and drop its tabs.
        for (const page of [...this.pages.values()]) if (page.port === port.port) this.detach(page.id);
        return;
      }
      if (!Array.isArray(list)) return;
      const live = new Map(list.filter(entry => entry.type === 'page').map(entry => [entry.id, entry]));
      for (const page of [...this.pages.values()]) {
        if (page.port !== port.port) continue;
        const entry = live.get(page.id);
        if (entry) page.title = entry.title;
        // Gone, or navigated away from the app: stop sampling it.
        if (!entry || (page.attached && !this.matches(page.url))) this.detach(page.id);
      }
      for (const entry of live.values()) {
        if (this.pages.has(entry.id) || !entry.webSocketDebuggerUrl || !this.matches(entry.url)) continue;
        if (Date.now() - (this.failedAt.get(entry.id) ?? 0) < ATTACH_RETRY_MS) continue;
        this.attach(entry, port);
      }
    } finally {
      this.polling.delete(port.port);
    }
  }

  async attach(entry, port) {
    const page = new PageTarget(this, entry, port);
    this.pages.set(page.id, page);
    try {
      await page.attach();
    } catch (error) {
      this.failedAt.set(page.id, Date.now());
      if (this.pages.get(page.id) === page) this.pages.delete(page.id);
      page.close();
      this.log(`Web: could not attach to ${entry.url} (${port.label}): ${error.message}`);
      return;
    }
    if (this.pages.get(page.id) !== page) return; // detached while attaching
    let tracer = this.tracers.get(port.port);
    if (!tracer) {
      tracer = new BrowserTracer({ port: port.port, label: port.label, log: this.log });
      this.tracers.set(port.port, tracer);
    }
    tracer.subscribe(page);
    this.log(`Web: attached to ${page.url} (${port.label})`);
    this.emitSafe('attached', { targetId: page.id, port: port.port, label: port.label, url: page.url });
  }

  detach(targetId) {
    const page = this.pages.get(targetId);
    if (!page) return;
    this.pages.delete(targetId);
    const wasAttached = page.attached;
    page.close();
    const tracer = this.tracers.get(page.port);
    if (tracer) {
      tracer.unsubscribe(page);
      if (!tracer.subscribers.size) this.tracers.delete(page.port);
    }
    if (wasAttached) {
      this.log(`Web: detached from ${page.url} (${page.label})`);
      this.emitSafe('detached', { targetId });
    }
  }

  page(targetId) {
    const page = this.pages.get(targetId);
    if (!page?.attached) throw new Error(`Not attached to target ${targetId}`);
    return page;
  }

  async evaluate(targetId, expression, options = {}) {
    return this.page(targetId).evaluate(expression, options);
  }

  // DevTools' "Collect garbage" button calls it twice: the first pass can leave objects whose
  // finalizers / weak callbacks only free more on the second.
  async collectGarbage(targetId) {
    const page = this.page(targetId);
    await page.connection.send('HeapProfiler.collectGarbage', {}, { timeoutMs: 30000 });
    await page.connection.send('HeapProfiler.collectGarbage', {}, { timeoutMs: 30000 });
  }

  async metrics(targetId) {
    const metrics = await this.page(targetId).metrics();
    return {
      heapUsedMb: round1((metrics.JSHeapUsedSize ?? 0) / 1048576),
      heapTotalMb: round1((metrics.JSHeapTotalSize ?? 0) / 1048576),
      nodes: metrics.Nodes ?? null,
      listeners: metrics.JSEventListeners ?? null,
      documents: metrics.Documents ?? null,
      frames: metrics.Frames ?? null,
      layoutCount: metrics.LayoutCount ?? null,
      styleCount: metrics.RecalcStyleCount ?? null
    };
  }

  async heapCounts(targetId, { onProgress } = {}) {
    const { snapshot } = await this.page(targetId).heapSnapshot(onProgress);
    return constructorCounts(snapshot);
  }

  async detachedDom(targetId, { onProgress } = {}) {
    const startedAt = Date.now();
    const { snapshot, bytes, parseMs } = await this.page(targetId).heapSnapshot(onProgress);
    onProgress?.({ phase: 'analyze' });
    const { totalDetached, groups } = detachedDomGroups(snapshot);
    return {
      snapshotMb: round1(bytes / 1048576),
      tookMs: Date.now() - startedAt,
      parseMs,
      nodeCount: snapshot.nodeCount,
      totalDetached,
      groups
    };
  }
}

// ---------- launching browsers ----------

const MAC_BROWSERS = [
  ['Google Chrome', 'Google Chrome.app/Contents/MacOS/Google Chrome'],
  ['Google Chrome Canary', 'Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary'],
  ['Microsoft Edge', 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
  ['Brave Browser', 'Brave Browser.app/Contents/MacOS/Brave Browser'],
  ['Chromium', 'Chromium.app/Contents/MacOS/Chromium']
];
const LINUX_BROWSERS = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser'];

function findBrowser() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return { name: path.basename(process.env.CHROME_PATH), binary: process.env.CHROME_PATH };
  }
  if (process.platform === 'darwin') {
    for (const dir of ['/Applications', path.join(os.homedir(), 'Applications')]) {
      for (const [name, relative] of MAC_BROWSERS) {
        const binary = path.join(dir, relative);
        if (fs.existsSync(binary)) return { name, binary };
      }
    }
    return null;
  }
  for (const dir of String(process.env.PATH ?? '').split(path.delimiter)) {
    for (const name of LINUX_BROWSERS) {
      const binary = path.join(dir, name);
      if (fs.existsSync(binary)) return { name, binary };
    }
  }
  return null;
}

// Opens `url` in a debuggable Chromium browser on `port`, reusing one that already listens there.
export async function launchChrome({ url, port = 9222, profileDir, log = console.log } = {}) {
  const existing = await devtoolsHttp(port, '/json/version').catch(() => null);
  if (existing && typeof existing === 'object') {
    if (url) {
      // Chrome ≥ 111 only accepts PUT here; older versions only GET.
      // new URL().href percent-encodes spaces / non-ASCII without double-encoding existing escapes.
      const target = `/json/new?${new URL(url).href}`;
      await devtoolsHttp(port, target, { method: 'PUT', timeoutMs: 5000 }).catch(() => devtoolsHttp(port, target, { timeoutMs: 5000 }));
    }
    const browser = String(existing.Browser ?? 'Chromium').split('/')[0];
    log(`Web: reusing ${browser} on port ${port}`);
    return { browser, reused: true, child: null };
  }
  const found = findBrowser();
  if (!found) {
    throw new Error('No Chromium-based browser found (looked for Google Chrome, Chrome Canary, Microsoft Edge, Brave and Chromium; set CHROME_PATH to use another).');
  }
  // A separate profile: Chrome ignores --remote-debugging-port when the default profile is
  // already open in a running instance (and refuses it for the default profile since v136).
  const userDataDir = profileDir ?? path.join(os.homedir(), '.cache', 'perf-tool', `chrome-${port}`);
  fs.mkdirSync(userDataDir, { recursive: true });
  const args = [`--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`, '--no-first-run', '--no-default-browser-check'];
  if (url) args.push(url);
  // Detached + unref: the browser outlives the server (closing it would lose the user's tabs).
  const child = spawn(found.binary, args, { detached: true, stdio: 'ignore' });
  child.on('error', error => log(`Web: ${found.name} failed to start: ${error.message}`));
  child.unref();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await devtoolsHttp(port, '/json/version').catch(() => null)) {
      log(`Web: started ${found.name} with remote debugging on port ${port}`);
      return { browser: found.name, reused: false, child };
    }
    if (child.exitCode !== null) break;
    await sleep(250);
  }
  throw new Error(`${found.name} did not open remote debugging on port ${port} (profile ${userDataDir})`);
}

// ---------- Android Chrome over adb ----------

let androidSerial = null;

async function adb(...command) {
  const serial = androidSerial ? ['-s', androidSerial] : [];
  const { stdout } = await execFileAsync('adb', [...serial, ...command], { timeout: 15000 });
  return stdout;
}

// Forwards Chrome's DevTools socket on the phone to `port` and the app's dev server ports back
// to the phone. Returns null (never throws) without adb or without exactly one device.
export async function androidChrome({ port = 9223, reversePorts = [], log = console.log } = {}) {
  let devices;
  try {
    const { stdout } = await execFileAsync('adb', ['devices'], { timeout: 10000 });
    devices = stdout
      .split('\n')
      .slice(1)
      .map(line => line.trim().split(/\s+/))
      .filter(([serial, state]) => serial && state === 'device')
      .map(([serial]) => serial);
  } catch {
    return null; // no adb on PATH, or the adb server would not start
  }
  const wanted = process.env.ANDROID_SERIAL;
  let serial = null;
  if (wanted) serial = devices.includes(wanted) ? wanted : null;
  else if (devices.length === 1) serial = devices[0];
  else if (devices.length > 1) log(`Android Chrome: ${devices.length} devices connected; set ANDROID_SERIAL to pick one.`);
  if (!serial) return null;
  androidSerial = serial;
  try {
    await adb('forward', `tcp:${port}`, 'localabstract:chrome_devtools_remote');
    for (const reversePort of reversePorts) await adb('reverse', `tcp:${reversePort}`, `tcp:${reversePort}`);
    const model = (await adb('shell', 'getprop', 'ro.product.model').catch(() => '')).trim() || serial;
    log(`Android Chrome: ${model} (${serial}) forwarded to port ${port}`);
    return { serial, model };
  } catch (error) {
    log(`Android Chrome: adb forward failed: ${error.message}`);
    return null;
  }
}

// adb shell joins its arguments into one device-side shell command: quote the URL for it.
const shellQuote = text => `'${String(text).replace(/'/g, `'\\''`)}'`;

export async function openOnAndroid(url) {
  const start = ['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', shellQuote(url)];
  // am start reports a missing package on stdout with exit code 0, hence the text check.
  const output = await adb(...start, 'com.android.chrome').catch(error => `Error: ${error.message}`);
  if (!/Error|does not exist|unable to resolve/i.test(output)) return;
  await adb(...start);
}
