#!/usr/bin/env node
// Live performance server for release builds made with `perf ios|android` (~/perf-tool).
// Receives samples from the in-app probe (JS + iOS native), samples Android threads/GC/frames over
// adb, streams everything to the dashboard and records sessions for before/after comparison.
//
//   node server.mjs --repo <project> [--android <package>] [--port 8099]

import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildComponentIndex } from './component-index.mjs';
import { loadCompilerCache, compilerIndex } from './compiler-report.mjs';
import { summarize, compareSummaries } from './summary.mjs';
import { followScreenPath } from './screen-path.mjs';
import { summaryToMarkdown, compareToMarkdown } from './export.mjs';
import { startCapture, replay, restartApp, listScenarios, loadScenario, scenarioFile } from './android-scenario.mjs';
import { startIosCapture, ensureRunner, replayIos, restartIosApp } from './ios-scenario.mjs';
import { autoCompare, autoCompareToMarkdown, loadAutoSession, saveAutoSession } from './auto.mjs';
import { androidExit, startIosCrashWatcher } from './crashes.mjs';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = name => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const repoRoot = path.resolve(option('--repo') ?? process.cwd());

const PORT = Number(option('--port') ?? 8099);
let androidPackage = option('--android') ?? null;
const RESULTS_DIR = path.join(os.homedir(), 'perf-results');
const HISTORY_SECONDS = 600;

fs.mkdirSync(RESULTS_DIR, { recursive: true });

const componentIndex = buildComponentIndex(repoRoot);
console.log(`Indexed ${componentIndex.size} component names from source.`);

let compilerStatus = compilerIndex(loadCompilerCache());
// Re-checks only files changed since the last run (cached per mtime), off the server's event loop.
const compilerRefresh = spawn(process.execPath, [path.join(here, 'compiler-report.mjs'), '--repo', repoRoot], {
  stdio: ['ignore', 'pipe', 'ignore']
});
compilerRefresh.stdout.once('data', chunk => console.log(`React Compiler: ${String(chunk).split('\n')[0]}`));
compilerRefresh.on('exit', () => {
  compilerStatus = compilerIndex(loadCompilerCache());
});

// Runtime evidence (useMemoCache on the fiber) wins over the static report.
function compilerFor(component, compiledAtRuntime) {
  if (compiledAtRuntime) return { status: 'compiled', source: 'runtime' };
  const entry = compilerStatus.get(component);
  if (!entry) return null;
  return { status: entry.status, memoSlots: entry.memoSlots, reasons: entry.reasons, line: entry.line };
}

const clients = new Set();
const history = [];
let recording = null;
let build = null; // progress of the build `perf` is running, from lib/build-progress.mjs
let lastJsAt = 0;
let lastNativeAt = 0;
const lastScreen = new Map(); // source -> { screen, at }
const lastRoute = new Map(); // source -> { screen, path, platform, at } (navigation path from the probe)
const sessions = new Map(); // probe sessionId (one per app launch) -> { source, platform, firstAt }
const pendingCommands = new Map(); // source -> command delivered in the reply to its next /js post
const SCREEN_FRESH_MS = 3000;
const sources = new Map(); // source -> last sample time
const previousHermes = new Map();
const ADB_SOURCE = 'android · this Mac';

// One source per running app: devices are told apart by address, the simulator and adb-forwarded
// Android devices arrive over loopback.
function sourceOf(request, platform) {
  // The Android app reaches the server over adb reverse (loopback) or, when that was not ready
  // yet, over Wi-Fi; either way it is the device the adb sampler watches: one source, so its JS
  // and native samples line up (screen labels, recordings).
  if (platform === 'android' && androidStarted) return ADB_SOURCE;
  const address = String(request.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  const where = address === '127.0.0.1' || address === '::1' ? 'this Mac' : address;
  return `${platform ?? 'app'} · ${where}`;
}

function fileFor(component) {
  return componentIndex.get(component) ?? null;
}

// Keyed per app process: counters from two devices (or an app restart) must never be subtracted.
function hermesDelta(key, stats) {
  if (!stats) return null;
  const previous = previousHermes.get(key);
  previousHermes.set(key, stats);
  // Counters restart with the app process; a drop means a new process, not negative work.
  const restarted = previous && (stats.js_numGCs ?? 0) < (previous.js_numGCs ?? 0);
  const diff = key =>
    previous && !restarted && typeof stats[key] === 'number' && typeof previous[key] === 'number'
      ? stats[key] - previous[key]
      : 0;
  return {
    gcCount: diff('js_numGCs'),
    gcCpuMs: Math.round(diff('js_gcCPUTime') * 1000 * 10) / 10,
    gcWallMs: Math.round(diff('js_gcTime') * 1000 * 10) / 10,
    allocatedMb: Math.round((diff('js_totalAllocatedBytes') / 1048576) * 100) / 100,
    heapMb: Math.round(((stats.js_heapSize ?? 0) / 1048576) * 10) / 10,
    allocatedNowMb: Math.round(((stats.js_allocatedBytes ?? 0) / 1048576) * 10) / 10
  };
}

function publish(event) {
  history.push(event);
  const cutoff = Date.now() - HISTORY_SECONDS * 1000;
  while (history.length && history[0].receivedAt < cutoff) history.shift();
  sources.set(event.source, event.receivedAt);
  if (recording && (!recording.info.source || recording.info.source === event.source)) {
    recording.stream.write(JSON.stringify(event) + '\n');
  }
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) client.write(line);
}

function handleJs(body, source) {
  lastJsAt = Date.now();
  if (body.sessionId && !sessions.has(body.sessionId)) {
    sessions.set(body.sessionId, { source, platform: body.platform, firstAt: Date.now(), build: body.build ?? null });
  }
  for (const sample of body.samples ?? []) {
    if (sample.screen) lastScreen.set(source, { screen: sample.screen, at: Date.now() });
    if (autoFollower?.source === source) autoFollower.path.see(sample.screen);
    if (sample.routePath?.length) {
      lastRoute.set(source, { screen: sample.screen, path: sample.routePath, platform: body.platform, at: Date.now(), build: body.build ?? null });
    }
    publish({
      type: 'js',
      source,
      platform: body.platform,
      receivedAt: Date.now(),
      t: sample.t,
      screen: sample.screen,
      routePath: sample.routePath?.length ? sample.routePath : undefined,
      commits: sample.commits,
      commitMs: sample.commitMs,
      jsFps: sample.jsFps,
      longTasks: sample.longTasks,
      longTaskMs: sample.longTaskMs,
      maxBlockMs: sample.maxBlockMs,
      screens: sample.screens,
      slowCommits: sample.slowCommits,
      triggers: sample.triggers ?? [],
      probeErrors: sample.probeErrors,
      hermes: hermesDelta(`${source}|${body.sessionId ?? ''}`, sample.hermes),
      network: sample.network ?? [],
      redux: sample.redux ?? null,
      build: body.build ?? null,
      components: sample.components.map(entry => ({
        ...entry,
        file: fileFor(entry.component),
        compiler: compilerFor(entry.component, entry.compiled)
      }))
    });
  }
}

// The app process ended abnormally: shown in the dashboard and kept in the recording.
function publishCrash(crash, source, platform) {
  const screen = lastScreen.get(source)?.screen ?? null;
  console.log(`${platform}: ${crash.reason}${crash.title ? ` — ${crash.title}` : ''}${screen ? ` (on ${screen})` : ''}`);
  const event = { type: 'crash', id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, source, platform, receivedAt: Date.now(), screen, ...crash };
  rememberCrash(event);
  publish(event);
}

function handleNative(body, source) {
  lastNativeAt = Date.now();
  publish({
    type: 'native',
    source,
    platform: body.platform,
    receivedAt: Date.now(),
    t: body.t,
    // A screen seen long ago (e.g. before the app restarted) must not label new native samples.
    screen: (() => {
      const last = lastScreen.get(source);
      return last && Date.now() - last.at < SCREEN_FRESH_MS ? last.screen : null;
    })(),
    cpuMs: body.cpuMs,
    threads: body.threads.sort((a, b) => b.cpuMs - a.cpuMs),
    ui: body.ui,
    memoryMb: body.memoryMb,
    gc: body.gc ?? null,
    thermal: body.thermal ?? null
  });
}

// ---------- Android (host side over adb) ----------

async function adb(...command) {
  const { stdout } = await execFileAsync('adb', command, { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

// Android sampling can be switched on in a running server (perf android), no restart needed.
function enableAndroid(packageName) {
  if (!packageName || (androidPackage === packageName && androidStarted)) return;
  androidPackage = packageName;
  androidStarted = true;
  startAndroidCollector(packageName);
}
let androidStarted = false;

function startAndroidCollector(packageName) {
  let pid = null;
  let previousTicks = new Map();
  let artGc = { count: 0, pauseMs: 0, totalMs: 0 };
  let logcat = null;
  let memory = null;
  let thermal = null;
  let tick = 0;

  const ensureReverse = () => adb('reverse', `tcp:${PORT}`, `tcp:${PORT}`).catch(() => {});

  const startLogcat = () => {
    logcat?.kill();
    logcat = spawn('adb', ['logcat', '-T', '1', `--pid=${pid}`, '-v', 'brief']);
    let buffer = '';
    logcat.stdout.on('data', chunk => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!/GC freed/.test(line)) continue;
        artGc.count += 1;
        const pauses = [...line.matchAll(/paused ([\d.]+)(ms|us)/g)];
        for (const match of pauses) artGc.pauseMs += Number(match[1]) / (match[2] === 'us' ? 1000 : 1);
        const total = line.match(/total ([\d.]+)(ms|us|s)/);
        if (total) artGc.totalMs += Number(total[1]) * (total[2] === 's' ? 1000 : total[2] === 'us' ? 0.001 : 1);
      }
    });
  };

  const readThreads = async () => {
    // A thread can exit between the glob and cat; `true` keeps that from failing the whole sample.
    const out = await adb('shell', `for f in /proc/${pid}/task/*/stat; do cat $f 2>/dev/null; done; true`);
    const ticks = new Map();
    for (const line of out.split('\n')) {
      const open = line.indexOf('(');
      const close = line.lastIndexOf(')');
      if (open === -1 || close === -1) continue;
      const tid = line.slice(0, open).trim();
      const name = line.slice(open + 1, close);
      const fields = line.slice(close + 2).split(' ');
      ticks.set(tid, { name: tid === String(pid) ? 'Main Thread (UI)' : name, ticks: Number(fields[11]) + Number(fields[12]) });
    }
    const byName = new Map();
    let totalMs = 0;
    for (const [tid, value] of ticks) {
      const previous = previousTicks.get(tid);
      if (!previous) continue;
      const ms = (value.ticks - previous.ticks) * 10;
      if (ms <= 0) continue;
      const name = /^(binder:|hwuiTask|RenderThread|mqt_|HeapTaskDaemon|FinalizerDaemon|Hermes|hades)/.test(value.name)
        ? value.name.replace(/[_:-]?\d+(_\d+)?$/, '')
        : value.name;
      byName.set(name, (byName.get(name) ?? 0) + ms);
      totalMs += ms;
    }
    previousTicks = ticks;
    return { totalMs, threads: [...byName.entries()].map(([name, cpuMs]) => ({ name, cpuMs })) };
  };

  const readFrames = async () => {
    const out = await adb('shell', 'dumpsys', 'gfxinfo', packageName, 'reset');
    const number = pattern => Number(out.match(pattern)?.[1] ?? 0);
    return {
      fps: number(/Total frames rendered: (\d+)/),
      janky: number(/Janky frames: (\d+)/),
      p90Ms: number(/90th percentile: (\d+)ms/),
      p99Ms: number(/99th percentile: (\d+)ms/),
      slowUiThread: number(/Number Slow UI thread: (\d+)/),
      frozen: number(/Number Frame deadline missed: (\d+)/)
    };
  };

  // Battery / CPU / skin temperature in °C and the throttling status (0 none … 6 shutdown).
  const readThermal = async () => {
    const [battery, thermal] = await Promise.all([
      adb('shell', 'dumpsys', 'battery').catch(() => ''),
      adb('shell', 'dumpsys', 'thermalservice').catch(() => '')
    ]);
    // The live readings; the "Cached temperatures" block above them can be minutes old.
    const current = (thermal.split('Current temperatures from HAL')[1] ?? thermal).split('Current cooling devices')[0];
    const hottest = type =>
      Math.max(...[...current.matchAll(/mValue=([\d.]+), mType=(\d+)/g)].filter(m => Number(m[2]) === type).map(m => Number(m[1])), -Infinity);
    const value = number => (Number.isFinite(number) ? Math.round(number * 10) / 10 : null);
    const tenths = Number(battery.match(/temperature: (\d+)/)?.[1]);
    return {
      batteryC: Number.isFinite(tenths) ? tenths / 10 : value(hottest(2)),
      cpuC: value(hottest(0)),
      skinC: value(hottest(3)),
      status: Number(thermal.match(/Thermal Status: (\d)/)?.[1] ?? NaN) || 0
    };
  };

  const readMemory = async () => {
    const out = await adb('shell', 'dumpsys', 'meminfo', packageName);
    const kb = pattern => Number(out.match(pattern)?.[1] ?? 0);
    return {
      totalMb: Math.round(kb(/TOTAL PSS:\s+(\d+)/) / 102.4) / 10 || Math.round(kb(/TOTAL\s+(\d+)/) / 102.4) / 10,
      javaHeapMb: Math.round(kb(/Java Heap:\s+(\d+)/) / 102.4) / 10,
      nativeHeapMb: Math.round(kb(/Native Heap:\s+(\d+)/) / 102.4) / 10
    };
  };

  // The watched process is gone: ask Android why, without holding up the sampling loop.
  const reportExit = exitedPid => {
    androidExit(adb, packageName, exitedPid)
      .then(crash => crash && publishCrash(crash, ADB_SOURCE, 'android'))
      .catch(error => console.warn(`Android exit info: ${error.message}`));
  };

  const loop = async () => {
    try {
      // pidof exits with an error while the app is not running yet; that is not a failure.
      const pidOut = (await adb('shell', 'pidof', packageName).catch(() => '')).trim().split(/\s+/)[0];
      if (pid && pidOut !== String(pid)) reportExit(pid);
      if (!pidOut) {
        pid = null;
        return;
      }
      if (pidOut !== String(pid)) {
        pid = Number(pidOut);
        previousTicks = new Map();
        await ensureReverse();
        startLogcat();
        console.log(`Android: attached to ${packageName} (pid ${pid})`);
        return;
      }
      tick += 1;
      if (tick % 5 === 1) [memory, thermal] = await Promise.all([readMemory(), readThermal()]);
      const [threads, ui] = await Promise.all([readThreads(), readFrames()]);
      const gc = artGc;
      artGc = { count: 0, pauseMs: 0, totalMs: 0 };
      const sample = {
        platform: 'android',
        t: Date.now(),
        cpuMs: threads.totalMs,
        threads: threads.threads,
        ui,
        memoryMb: memory?.totalMb ?? null,
        gc: { artCount: gc.count, artPauseMs: Math.round(gc.pauseMs * 10) / 10, artTotalMs: Math.round(gc.totalMs), ...memory },
        thermal
      };
      handleNative(sample, ADB_SOURCE);
    } catch (error) {
      if (!/no devices|device offline|not found/.test(String(error))) console.warn(`Android sampling: ${error.message}`);
    }
  };

  ensureReverse();
  setInterval(loop, 1000);
  console.log(`Android: waiting for ${packageName} (adb reverse tcp:${PORT})`);
}

// ---------- Recording ----------

function startRecording(label, source) {
  if (recording) return recording.info;
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const safeLabel = String(label || 'session').replace(/[^\w.-]+/g, '_').slice(0, 60);
  const id = `${stamp}_${safeLabel}`;
  const dir = path.join(RESULTS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  recording = {
    info: { id, label: safeLabel, source: source || null, startedAt: Date.now() },
    dir,
    stream: fs.createWriteStream(path.join(dir, 'samples.ndjson'))
  };
  console.log(`Recording → ${dir}${source ? ` (${source})` : ''}`);
  return recording.info;
}

async function stopRecording() {
  if (!recording) return null;
  const current = recording;
  recording = null;
  await new Promise(resolve => current.stream.end(resolve));
  const events = readEvents(current.dir);
  const summary = summarize(events, { ...current.info, stoppedAt: Date.now() });
  fs.writeFileSync(path.join(current.dir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(`Saved ${current.info.id} (${events.length} samples)`);
  return summary;
}

function readEvents(dir) {
  return fs
    .readFileSync(path.join(dir, 'samples.ndjson'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function listRecordings() {
  return fs
    .readdirSync(RESULTS_DIR)
    .filter(id => fs.existsSync(path.join(RESULTS_DIR, id, 'summary.json')))
    .sort()
    .reverse()
    .map(id => {
      const summary = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, id, 'summary.json'), 'utf8'));
      return { id, label: summary.meta.label, platform: summary.meta.platform, durationSec: summary.meta.durationSec };
    });
}

function recordingDir(id) {
  const dir = path.join(RESULTS_DIR, path.basename(String(id ?? '')));
  if (!id || !fs.existsSync(path.join(dir, 'summary.json'))) throw new Error(`Unknown recording '${id}'`);
  return dir;
}

function deleteRecording(id) {
  if (recording?.info.id === id) throw new Error('Stop the recording before deleting it');
  fs.rmSync(recordingDir(id), { recursive: true, force: true });
}

// Master clear: every saved recording plus the auto before/after sets that point at them.
// Scenarios (the captured gestures) are kept, so Auto can run again without a new capture.
function clearAllRecordings() {
  if (recording) throw new Error('Stop the recording before clearing everything');
  if (capture || auto.phase !== 'idle') throw new Error('Wait for Auto to finish (or cancel it) before clearing everything');
  const ids = fs.readdirSync(RESULTS_DIR).filter(id => fs.existsSync(path.join(RESULTS_DIR, id, 'summary.json')));
  for (const id of ids) fs.rmSync(path.join(RESULTS_DIR, id), { recursive: true, force: true });
  fs.rmSync(path.join(RESULTS_DIR, 'auto'), { recursive: true, force: true });
  return ids.length;
}

function liveSummary(seconds, source) {
  const cutoff = Date.now() - seconds * 1000;
  const events = history.filter(event => event.receivedAt >= cutoff && (!source || event.source === source));
  return summarize(events, {
    id: `live-last-${seconds}s${source ? ` (${source})` : ''}`,
    label: 'live',
    source: source || null,
    startedAt: events[0]?.receivedAt
  });
}

// A recording id, or "live:<seconds>" for the live window of the selected device (?source=).
function resolveSummary(id, url) {
  const live = String(id ?? '').match(/^live:(\d+)$/);
  if (!live) return loadSummary(id);
  const seconds = Math.min(HISTORY_SECONDS, Math.max(5, Number(live[1])));
  return liveSummary(seconds, url.searchParams.get('source') || null);
}

const fileName = id => String(id).replace(/[^\w.-]+/g, '_');

// Adds the compiler status of the source as it is now to a comparison's not-memoized list.
function withCurrentCompiler(result) {
  const notMemoized = (result.notMemoized ?? []).map(row => ({ ...row, compilerNow: compilerStatus.get(row.component)?.status ?? null }));
  return { ...result, notMemoized };
}

function sendText(response, text, filename) {
  response.writeHead(200, {
    'Content-Type': 'text/markdown; charset=utf-8',
    ...(filename ? { 'Content-Disposition': `attachment; filename="${filename}"` } : {})
  });
  response.end(text);
}

function loadSummary(id) {
  return JSON.parse(fs.readFileSync(path.join(recordingDir(id), 'summary.json'), 'utf8'));
}

// ---------- Automatic before/after (Android and iOS) ----------
// Start auto: the gestures are captured from the screen the app is on. Stop: the scenario is
// saved and replayed on this build (before). Replay after a change: the same scenario on the new
// build (after), then the comparison. Every replay restarts the app, waits for the probe, opens the
// start screen through the probe and lets it settle before the gestures begin.

const AUTO_COOLDOWN_MS = 10000;
const MAX_DIVERGED_RETRIES = 2;
// The running replay's check against the scenario's screen order (scenarios captured with it).
let autoFollower = null;
const AUTO_SETTLE_MS = 3000;
const ROUTE_FRESH_MS = 5000;
const CACHE_DIR = path.join(os.homedir(), 'Library', 'Caches', 'perf-tool', path.basename(repoRoot));

// Crashes outlive the live window and server restarts: the dashboard shows them until dismissed.
const CRASHES_FILE = path.join(CACHE_DIR, 'crashes.json');
const CRASH_KEEP_MS = 7 * 24 * 3600 * 1000;
const CRASH_KEEP_COUNT = 100;
let crashLog = (() => {
  try {
    return JSON.parse(fs.readFileSync(CRASHES_FILE, 'utf8')).filter(crash => Date.now() - crash.receivedAt < CRASH_KEEP_MS);
  } catch {
    return [];
  }
})();

function saveCrashLog() {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CRASHES_FILE, JSON.stringify(crashLog));
  } catch (error) {
    console.warn(`Crashes: could not save ${CRASHES_FILE}: ${error.message}`);
  }
}

function rememberCrash(event) {
  crashLog = [...crashLog, event].filter(crash => Date.now() - crash.receivedAt < CRASH_KEEP_MS).slice(-CRASH_KEEP_COUNT);
  saveCrashLog();
}

function dismissCrashes(ids) {
  const dismissed = new Set(ids);
  crashLog = crashLog.filter(crash => !dismissed.has(crash.id));
  saveCrashLog();
  const line = `data: ${JSON.stringify({ type: 'crashes-dismissed', ids: [...dismissed] })}\n\n`;
  for (const client of clients) client.write(line);
}
let stopIosCrashWatcher = null;
// Crash, Jetsam and resource reports of the app from the device, credited to its latest iOS source.
function watchIosCrashes(target) {
  stopIosCrashWatcher?.();
  stopIosCrashWatcher = null;
  if (target.kind !== 'device') return;
  stopIosCrashWatcher = startIosCrashWatcher({
    target,
    cacheDir: path.join(CACHE_DIR, 'crash-logs'),
    onReport: report => {
      const source = [...sessions.values()].reverse().find(item => item.platform === 'ios')?.source ?? `ios · ${target.name}`;
      publishCrash(report, source, 'ios');
    }
  });
  console.log(`iOS: watching crash logs of ${target.bundle} on ${target.name}`);
}
let iosTarget = null; // { udid, kind, bundle, team, name } from the last `perf ios`
let capture = null;
let autoCancelled = false;
let autoRuns = 3;
const auto = { phase: 'idle', scenario: null, which: null, run: 0, runs: 0, step: '', error: null, completed: null };

function autoState() {
  return {
    ...auto,
    capture: capture ? { name: capture.name, platform: capture.platform, startedAt: capture.startedAt } : null,
    android: androidPackage,
    ios: iosTarget ? `${iosTarget.name} (${iosTarget.kind})` : null,
    current: { android: activeApp('android'), ios: activeApp('ios') }
  };
}

// Progress goes to the dashboards only; it is not part of the samples or recordings.
function publishAuto(update) {
  Object.assign(auto, update);
  const line = `data: ${JSON.stringify({ type: 'auto', auto: autoState() })}\n\n`;
  for (const client of clients) client.write(line);
}

// The app of a platform that sent its route most recently, with the screen it is on.
function activeApp(platform) {
  let best = null;
  for (const [source, route] of lastRoute) {
    if (route.platform !== platform || Date.now() - route.at > ROUTE_FRESH_MS) continue;
    if (!best || route.at > best.at) best = { source, ...route };
  }
  return best;
}

function assertAutoIdle(platform) {
  if (!['android', 'ios'].includes(platform)) throw new Error("platform must be 'android' or 'ios'");
  if (platform === 'android' && !androidPackage) throw new Error('Android automatic runs need Android sampling: start with perf android');
  if (platform === 'ios' && !iosTarget) throw new Error('iOS automatic runs need a probe build: start with perf ios');
  if (capture || auto.phase === 'running') throw new Error('An automatic capture or run is already in progress');
  if (recording) throw new Error('Stop the current recording first');
}

const cancellableSleep = async ms => {
  const until = Date.now() + ms;
  while (!autoCancelled && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 250));
};

async function waitFor(check, timeoutMs, message) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (autoCancelled) return null;
    const value = check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(message);
}

async function startAutoCapture(name, platform, runs) {
  assertAutoIdle(platform);
  const app = activeApp(platform);
  if (!app?.path?.length) throw new Error(`Open the app on the screen where the scenario starts (no ${platform} probe data right now)`);
  const start = { screen: app.screen, path: app.path };
  const scenarioName = String(name || '').trim() || String(app.screen || 'scenario').toLowerCase();
  autoRuns = Math.min(10, Math.max(1, Number(runs) || 3));
  capture =
    platform === 'ios'
      ? await startIosCapture({ name: scenarioName, target: iosTarget, resultsDir: RESULTS_DIR, scenarioFile, start })
      : { platform: 'android', ...(await startCapture({ name: scenarioName, packageName: androidPackage, resultsDir: RESULTS_DIR, start })) };
  // The person's own pass is recorded too, so it can be looked at like any other recording.
  startRecording(`${capture.name}-capture`, app.source);
  publishAuto({ phase: 'capturing', scenario: capture.name, completed: null, error: null, step: `Recording your actions from ${app.screen}; press Stop when done` });
}

// Saves the scenario and replays it on this build right away: that is the before set.
async function stopAutoCapture() {
  if (!capture) throw new Error('No capture in progress');
  const scenario = capture.stop();
  capture = null;
  const captured = await stopRecording();
  // The screens the person went through, and in which order: a replay that goes elsewhere has diverged.
  scenario.screens = (captured?.screens ?? []).filter(row => row.seconds >= 1 && row.screen !== '(unknown)').map(row => row.screen);
  scenario.screenPath = captured?.screenPath ?? [];
  fs.writeFileSync(scenarioFile(RESULTS_DIR, scenario.name), JSON.stringify(scenario, null, 2));
  publishAuto({ phase: 'idle', scenario: scenario.name, step: `Saved ${scenario.name}: ${scenario.gestures.length} gestures, ${Math.round(scenario.durationMs / 1000)} s` });
  if (scenario.gestures.length) runAuto(scenario.name, 'before', autoRuns);
  else publishAuto({ error: `No gestures were captured (touch device: ${capture?.touchDevice ?? scenario.touchDevice ?? 'unknown'}). Use the phone itself between Start and Stop.` });
  return scenario;
}

const COOLDOWN_MAX_MS = 180000;
const COOLDOWN_MARGIN_C = 0.5;

// Latest temperature of the platform's app: °C and throttling level on Android, level on iOS.
function currentThermal(platform) {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const event = history[index];
    if (event.type === 'native' && event.platform === platform && event.thermal && Date.now() - event.receivedAt < 15000) {
      return { batteryC: event.thermal.batteryC ?? null, level: event.thermal.status ?? event.thermal.state ?? 0 };
    }
  }
  return null;
}

// A warmer phone throttles the CPU and makes every number worse: each run waits until the phone
// is back at the temperature the first before run started at (at most 3 minutes).
async function coolDownTo(platform, baseline) {
  if (!baseline) return;
  const coolEnough = () => {
    const now = currentThermal(platform);
    if (!now) return true;
    if (baseline.batteryC != null && now.batteryC != null) return now.batteryC <= baseline.batteryC + COOLDOWN_MARGIN_C && now.level <= baseline.level;
    return now.level <= baseline.level;
  };
  const until = Date.now() + COOLDOWN_MAX_MS;
  while (!autoCancelled && !coolEnough() && Date.now() < until) {
    const now = currentThermal(platform);
    const target = baseline.batteryC != null ? `${baseline.batteryC + COOLDOWN_MARGIN_C}°C` : 'the starting thermal state';
    publishAuto({ step: `Cooling down: ${now?.batteryC != null ? `${now.batteryC}°C` : `level ${now?.level}`} → waiting for ${target} (${Math.round((until - Date.now()) / 1000)} s left)` });
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

// The code identity the probe build reports, from the app of that platform running now.
function currentBuild(platform) {
  return activeApp(platform)?.build ?? [...sessions.values()].reverse().find(item => item.platform === platform)?.build ?? null;
}

// Restarted app → probe connected → on the start screen → settled. Returns the app's source.
async function prepareRun(platform, scenario) {
  const since = Date.now();
  if (platform === 'ios') await restartIosApp(iosTarget);
  else await restartApp(androidPackage);
  publishAuto({ step: 'Waiting for the app to start' });
  const session = await waitFor(
    () => [...sessions.values()].find(item => item.platform === platform && item.firstAt >= since),
    90000,
    'The app did not report after the restart (is it the probe build?)'
  );
  if (!session) return null;
  const route = () => {
    const value = lastRoute.get(session.source);
    return value && value.at >= since ? value : null;
  };
  await waitFor(route, 60000, 'The app did not reach its first screen');
  const target = scenario.start?.path;
  const targetScreen = scenario.start?.screen;
  // The app may still route on its own right after start (splash, home): retry until it stays.
  for (let attempt = 1; targetScreen && attempt <= 3 && route()?.screen !== targetScreen; attempt += 1) {
    if (autoCancelled) return null;
    publishAuto({ step: `Opening ${targetScreen}` });
    pendingCommands.set(session.source, { type: 'navigate', path: target });
    await waitFor(() => route()?.screen === targetScreen, 15000, `Could not open ${targetScreen}`).catch(() => null);
    await cancellableSleep(1000);
  }
  if (targetScreen && route()?.screen !== targetScreen) throw new Error(`Could not open ${targetScreen} (the app is on ${route()?.screen})`);
  publishAuto({ step: `On ${targetScreen ?? route()?.screen}, letting it settle` });
  await cancellableSleep(AUTO_SETTLE_MS);
  return session.source;
}

async function runAuto(name, which, runs) {
  const scenario = loadScenario(RESULTS_DIR, name);
  const platform = scenario.platform ?? 'android';
  const ids = [];
  autoCancelled = false;
  publishAuto({ phase: 'running', scenario: name, which, run: 0, runs, step: 'Starting', error: null, completed: null });
  try {
    const xctestrun =
      platform === 'ios'
        ? await ensureRunner({ target: iosTarget, toolRoot: path.join(here, '..'), cacheDir: CACHE_DIR, onStep: step => publishAuto({ step }) })
        : null;
    const session = loadAutoSession(RESULTS_DIR, name);
    // The first before run fixes the temperature every later run (before and after) starts at.
    let baseline = which === 'before' ? currentThermal(platform) : session.baseline ?? null;
    let diverged = 0;
    for (let run = 1; run <= runs && !autoCancelled; run += 1) {
      await coolDownTo(platform, baseline);
      publishAuto({ run, step: 'Restarting the app' });
      const source = await prepareRun(platform, scenario);
      if (!source) break;
      const label = `auto-${name}-${which}-${run}`;
      // Follows the screens while the run goes, so a run that leaves the captured order stops at once.
      const follower = scenario.screenPath?.length > 1 ? { source, path: followScreenPath(scenario.screenPath) } : null;
      autoFollower = follower;
      const leftPath = () => follower?.path.offPath() ?? null;
      const options = {
        onStep: step => publishAuto({ step }),
        isCancelled: () => autoCancelled || leftPath() != null,
        onStart: () => startRecording(label, source)
      };
      let completed;
      try {
        completed =
          platform === 'ios'
            ? await replayIos(scenario, { ...options, target: iosTarget, xctestrun, onLaunch: options.onStart })
            : await replay(scenario, options);
      } finally {
        autoFollower = null;
      }
      const summary = await stopRecording();
      if (!completed && !leftPath()) {
        if (summary) deleteRecording(summary.meta.id);
        break;
      }
      // A gesture can hit something else than during the capture (a carousel moved on, content
      // changed): that run measured a different journey, so it is redone.
      const divergence = (() => {
        if (leftPath()) return `went to ${leftPath()} instead of following ${scenario.screenPath.join(' → ')}`;
        const missing = follower?.path.missing() ?? [];
        if (missing.length) return `never reached ${missing[0]} (scenario: ${scenario.screenPath.join(' → ')})`;
        const unexpected = scenario.screens?.length
          ? summary.screens.filter(row => row.seconds >= 1 && row.screen !== '(unknown)' && !scenario.screens.includes(row.screen)).map(row => row.screen)
          : [];
        return unexpected.length ? `opened ${unexpected.join(', ')}, which the scenario never visits` : null;
      })();
      if (divergence) {
        if (summary) deleteRecording(summary.meta.id);
        diverged += 1;
        if (diverged > MAX_DIVERGED_RETRIES) {
          throw new Error(`Run ${run} kept diverging (${divergence}): capture the scenario again without tapping banners or other moving content`);
        }
        publishAuto({ step: `Run ${run} ${divergence}: repeating it` });
        run -= 1;
        continue;
      }
      ids.push(summary.meta.id);
      if (run < runs) {
        publishAuto({ step: `Cooling down ${AUTO_COOLDOWN_MS / 1000} s` });
        await cancellableSleep(AUTO_COOLDOWN_MS);
      }
    }
    // A cancelled run keeps the previous set: comparing a partial set would mislead.
    const finished = !autoCancelled && ids.length === runs;
    if (finished) {
      saveAutoSession(RESULTS_DIR, {
        ...loadAutoSession(RESULTS_DIR, name),
        [which]: ids,
        [`${which}At`]: Date.now(),
        [`${which}Build`]: currentBuild(platform),
        ...(which === 'before' ? { baseline } : {})
      });
    }
    const hint = which === 'before' ? ' — make the change, rebuild, then press Replay' : '';
    publishAuto({ phase: 'idle', completed: finished ? which : null, step: autoCancelled ? 'Cancelled' : `${which}: ${ids.length} runs saved${hint}` });
  } catch (error) {
    // The interrupted run is incomplete; the runs finished before it stay as plain recordings.
    const partial = await stopRecording();
    if (partial) deleteRecording(partial.meta.id);
    publishAuto({ phase: 'idle', error: error.message, step: '' });
  }
}

// ---------- HTTP ----------

function readBody(request) {
  return new Promise((resolve, reject) => {
    let data = '';
    request.on('data', chunk => (data += chunk));
    request.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function sendJson(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://localhost:${PORT}`);
  try {
    if (request.method === 'GET' && url.pathname === '/ping') return sendJson(response, 200, { ok: true });
    if (request.method === 'POST' && url.pathname === '/js') {
      const body = await readBody(request);
      const source = sourceOf(request, body.platform);
      handleJs(body, source);
      const command = pendingCommands.get(source);
      pendingCommands.delete(source);
      return sendJson(response, 200, command ? { ok: true, command } : { ok: true });
    }
    // Drives the app to a screen ({ path: [{ name, params? }, …] }, as the probe reports routePath),
    // so a measurement can start from a known screen without touching the device.
    if (request.method === 'POST' && url.pathname === '/navigate') {
      const body = await readBody(request);
      if (!Array.isArray(body.path) || !body.path.length) throw new Error('path is required');
      // Required: other apps on the network may report here too, and only the chosen one may move.
      if (!body.source) throw new Error('source is required (the device, as the dashboard lists it)');
      if (!sources.has(body.source)) throw new Error(`Unknown source '${body.source}'`);
      pendingCommands.set(body.source, { type: 'navigate', path: body.path });
      return sendJson(response, 200, { ok: true, source: body.source });
    }
    if (request.method === 'POST' && url.pathname === '/native') {
      const body = await readBody(request);
      handleNative(body, sourceOf(request, body.platform));
      return sendJson(response, 200, { ok: true });
    }
    if (request.method === 'GET' && url.pathname === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return response.end(fs.readFileSync(path.join(here, 'dashboard.html')));
    }
    if (request.method === 'GET' && url.pathname === '/events') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      response.write(`data: ${JSON.stringify({ type: 'hello', history, crashes: crashLog, recording: recording?.info ?? null, build })}\n\n`);
      clients.add(response);
      request.on('close', () => clients.delete(response));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/status') {
      return sendJson(response, 200, {
        lastJsAt,
        lastNativeAt,
        recording: recording?.info ?? null,
        android: androidPackage,
        sources: Object.fromEntries(sources)
      });
    }
    if (request.method === 'POST' && url.pathname === '/record/start') {
      const body = await readBody(request);
      return sendJson(response, 200, startRecording(body.label, body.source));
    }
    if (request.method === 'POST' && url.pathname === '/android') {
      const body = await readBody(request);
      enableAndroid(body.package);
      return sendJson(response, 200, { android: androidPackage });
    }
    if (request.method === 'POST' && url.pathname === '/record/stop') return sendJson(response, 200, await stopRecording());
    if (request.method === 'GET' && url.pathname === '/recordings') return sendJson(response, 200, listRecordings());
    if (request.method === 'POST' && url.pathname === '/recordings/delete') {
      deleteRecording(url.searchParams.get('id'));
      return sendJson(response, 200, { ok: true });
    }
    if (request.method === 'POST' && url.pathname === '/build') {
      build = await readBody(request);
      for (const client of clients) client.write(`data: ${JSON.stringify({ type: 'build', build })}\n\n`);
      return sendJson(response, 200, { ok: true });
    }
    if (request.method === 'POST' && url.pathname === '/recordings/clear-all') {
      return sendJson(response, 200, { deleted: clearAllRecordings() });
    }
    if (request.method === 'POST' && url.pathname === '/crashes/dismiss') {
      const body = await readBody(request);
      dismissCrashes(Array.isArray(body.ids) ? body.ids.map(String) : []);
      return sendJson(response, 200, { ok: true });
    }
    if (request.method === 'POST' && url.pathname === '/live/clear') {
      history.length = 0;
      previousHermes.clear();
      for (const client of clients) client.write(`data: ${JSON.stringify({ type: 'clear' })}\n\n`);
      return sendJson(response, 200, { ok: true });
    }
    // ?download=1 sends the text as a .md file, otherwise it is returned for copying.
    if (request.method === 'GET' && url.pathname === '/export') {
      const id = url.searchParams.get('id');
      const download = url.searchParams.get('download') ? `${fileName(id)}.md` : null;
      return sendText(response, summaryToMarkdown(resolveSummary(id, url)), download);
    }
    if (request.method === 'GET' && url.pathname === '/export/compare') {
      const a = url.searchParams.get('a');
      const b = url.searchParams.get('b');
      const download = url.searchParams.get('download') ? `compare_${fileName(a)}__${fileName(b)}.md` : null;
      return sendText(response, compareToMarkdown(withCurrentCompiler(compareSummaries(resolveSummary(a, url), resolveSummary(b, url)))), download);
    }
    if (request.method === 'GET' && url.pathname === '/export/live') {
      const seconds = Math.min(HISTORY_SECONDS, Math.max(5, Number(url.searchParams.get('seconds') ?? 60)));
      const download = url.searchParams.get('download') ? `live-last-${seconds}s.md` : null;
      return sendText(response, summaryToMarkdown(liveSummary(seconds, url.searchParams.get('source') || null)), download);
    }
    if (request.method === 'GET' && url.pathname === '/auto') {
      return sendJson(response, 200, { ...autoState(), scenarios: listScenarios(RESULTS_DIR) });
    }
    if (request.method === 'GET' && url.pathname === '/auto/session') {
      return sendJson(response, 200, loadAutoSession(RESULTS_DIR, path.basename(url.searchParams.get('scenario') ?? '')));
    }
    if (request.method === 'POST' && url.pathname === '/ios') {
      const body = await readBody(request);
      if (!body.udid || !body.bundle) throw new Error('udid and bundle are required');
      iosTarget = { udid: body.udid, kind: body.kind === 'simulator' ? 'simulator' : 'device', bundle: body.bundle, team: body.team || null, name: body.name || body.udid, executable: body.executable || null };
      watchIosCrashes(iosTarget);
      publishAuto({});
      return sendJson(response, 200, autoState());
    }
    if (request.method === 'POST' && url.pathname === '/gesture') {
      const body = await readBody(request);
      if (capture?.platform === 'ios' && body.platform === 'ios') capture.add(body, Date.now());
      return sendJson(response, 200, { ok: true });
    }
    if (request.method === 'POST' && url.pathname === '/auto/capture/start') {
      const body = await readBody(request);
      await startAutoCapture(body.name, body.platform, body.runs);
      return sendJson(response, 200, autoState());
    }
    if (request.method === 'POST' && url.pathname === '/auto/capture/stop') return sendJson(response, 200, await stopAutoCapture());
    if (request.method === 'POST' && url.pathname === '/auto/run') {
      const body = await readBody(request);
      const scenario = loadScenario(RESULTS_DIR, body.scenario);
      if (!scenario.gestures.length) throw new Error(`Scenario ${scenario.name} has no gestures: capture it again with Start auto`);
      assertAutoIdle(scenario.platform ?? 'android');
      // An after set on the very build the before set ran on measures nothing but noise.
      const beforeBuild = loadAutoSession(RESULTS_DIR, scenario.name).beforeBuild;
      const appBuild = currentBuild(scenario.platform ?? 'android');
      if (body.which === 'after' && beforeBuild?.code && appBuild?.code === beforeBuild.code) {
        throw new Error(`The app is still the before build (${appBuild.code}): make the change and rebuild with perf ${scenario.platform ?? 'android'} first`);
      }
      if (!['before', 'after'].includes(body.which)) throw new Error("which must be 'before' or 'after'");
      runAuto(body.scenario, body.which, Math.min(10, Math.max(1, Number(body.runs) || 3)));
      return sendJson(response, 200, autoState());
    }
    if (request.method === 'POST' && url.pathname === '/auto/cancel') {
      autoCancelled = true;
      return sendJson(response, 200, autoState());
    }
    if (request.method === 'GET' && url.pathname === '/auto/compare') {
      const scenario = path.basename(url.searchParams.get('scenario') ?? '');
      return sendJson(response, 200, autoCompare(loadAutoSession(RESULTS_DIR, scenario), loadSummary));
    }
    if (request.method === 'GET' && url.pathname === '/export/auto') {
      const scenario = path.basename(url.searchParams.get('scenario') ?? '');
      const result = withCurrentCompiler(autoCompare(loadAutoSession(RESULTS_DIR, scenario), loadSummary));
      const download = url.searchParams.get('download') ? `auto_${fileName(scenario)}.md` : null;
      return sendText(response, autoCompareToMarkdown(result, loadScenario(RESULTS_DIR, scenario)), download);
    }
    if (request.method === 'GET' && url.pathname === '/summary') return sendJson(response, 200, resolveSummary(url.searchParams.get('id'), url));
    if (request.method === 'GET' && url.pathname === '/compare') {
      return sendJson(
        response,
        200,
        compareSummaries(resolveSummary(url.searchParams.get('a'), url), resolveSummary(url.searchParams.get('b'), url))
      );
    }
    sendJson(response, 404, { error: 'not found' });
  } catch (error) {
    sendJson(response, 500, { error: error.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Perf dashboard: http://localhost:${PORT}`);
  console.log(`Results: ${RESULTS_DIR}`);
});

if (androidPackage) enableAndroid(androidPackage);

// SIGTERM comes from `perf ios|android` on Ctrl-C (background processes ignore SIGINT).
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    autoCancelled = true;
    if (capture) capture.stop();
    await stopRecording();
    process.exit(0);
  });
}
