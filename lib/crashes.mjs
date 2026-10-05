// Finds out why the app process ended, so a crash or a system kill shows up in the dashboard and in
// recordings instead of the samples just stopping.
//
// Android: when the watched pid goes away, `dumpsys activity exit-info` says why (crash, native
// crash, ANR, low memory, killed by the system…) and the crash log buffer holds the details.
// iOS: the device's crash logs (via devicectl) are polled for new reports of the app: crashes, CPU
// and memory resource reports and Jetsam (out of memory) kills.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const execFileAsync = promisify(execFile);

// ---------- Android ----------

// ApplicationExitInfo reasons that mean the process did not end because the user or an update
// asked for it. 13 (OTHER KILLS BY SYSTEM) is kept: it also covers kills of a frozen/cached app.
const ANDROID_REASONS = {
  2: { kind: 'signal', label: 'Killed by a signal' },
  3: { kind: 'oom', label: 'Killed for low memory' },
  4: { kind: 'crash', label: 'Crash (Java/Kotlin)' },
  5: { kind: 'crash', label: 'Native crash' },
  6: { kind: 'anr', label: 'ANR (app not responding)' },
  7: { kind: 'crash', label: 'Crash during start' },
  9: { kind: 'resource', label: 'Killed for excessive resource use' },
  12: { kind: 'signal', label: 'A process it depends on died' },
  13: { kind: 'killed', label: 'Killed by the system' }
};

export function parseExitInfo(text) {
  const entries = [];
  let current = null;
  for (const line of text.split('\n')) {
    if (/ApplicationExitInfo #\d+:/.test(line)) {
      current = {};
      entries.push(current);
      continue;
    }
    const match = current && line.match(/^\s+(\w+)=(.*)$/);
    if (match) current[match[1]] = match[2].trim();
  }
  return entries.map(entry => ({
    pid: Number(entry.pid),
    process: entry.process,
    timestamp: entry.timestamp,
    reason: Number(entry.reason?.split(' ')[0]),
    reasonText: entry.reason?.replace(/^\d+\s*/, '').replace(/[()]/g, '') ?? '',
    subreason: entry.subreason?.replace(/^\d+\s*/, '').replace(/[()]/g, '') ?? '',
    description: entry.description ?? '',
    pssMb: Number.parseFloat(entry.pss) || null,
    rssMb: Number.parseFloat(entry.rss) || null
  }));
}

// The details of the crash of `pid` in the crash log buffer (`logcat -b crash -v threadtime`):
// the tombstone of a native crash or the stack of a Java exception.
export function parseAndroidCrashLog(text, pid) {
  const lines = text.split('\n');
  const details = { title: null, signal: null, thread: null, frames: [] };

  // Native: "F libc : Fatal signal 6 (SIGABRT) … in tid 123 (Binder:…), pid 456 (…)", then a tombstone
  // written by crash_dump: "pid: 456, tid: 123, name: …", "Abort message: '…'", "backtrace:", "#00 pc …".
  const fatal = lines.find(line => line.includes('Fatal signal') && line.includes(`pid ${pid} `));
  if (fatal) {
    details.signal = fatal.match(/Fatal signal \d+ \((\w+)\)/)?.[1] ?? null;
    details.thread = fatal.match(/in tid \d+ \(([^)]+)\)/)?.[1] ?? null;
  }
  const tombstoneStart = lines.findIndex(line => new RegExp(`pid: ${pid}, tid: \\d+, name: `).test(line));
  if (tombstoneStart !== -1) {
    let inBacktrace = false;
    for (const line of lines.slice(tombstoneStart, tombstoneStart + 200)) {
      const abort = line.match(/Abort message: '(.*)'/);
      if (abort) details.title = abort[1];
      if (line.includes('backtrace:')) {
        inBacktrace = true;
        continue;
      }
      if (!inBacktrace) continue;
      const frame = line.match(/#\d+ pc [0-9a-f]+\s+(.*)$/);
      if (!frame) break;
      if (details.frames.length < 10) details.frames.push(frame[1].replace(/\s*\(BuildId: [0-9a-f]+\)/, ''));
    }
  }

  // Java/Kotlin: "E AndroidRuntime: FATAL EXCEPTION: main", "Process: pkg, PID: 456", then the stack.
  const processLine = lines.findIndex(line => line.includes('AndroidRuntime') && line.includes(`PID: ${pid}`));
  if (processLine !== -1) {
    const stack = [];
    for (const line of lines.slice(processLine + 1, processLine + 40)) {
      if (!line.includes('AndroidRuntime')) break;
      stack.push(line.split('AndroidRuntime: ').slice(1).join('AndroidRuntime: ').trim());
    }
    details.title = stack[0] ?? details.title;
    details.frames = stack.slice(1, 11);
    details.thread = lines[processLine - 1]?.match(/FATAL EXCEPTION: (.*)$/)?.[1] ?? details.thread;
  }
  return details;
}

// Why the app process `pid` of `packageName` ended, or null when the user or an install ended it.
// exit-info is written shortly after the process is gone, so it is asked a few times.
export async function androidExit(adb, packageName, pid) {
  for (let attempt = 0; attempt < 5; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1500));
    const text = await adb('shell', 'dumpsys', 'activity', 'exit-info', packageName).catch(() => '');
    const exit = parseExitInfo(text).find(entry => entry.pid === pid);
    if (!exit) continue;
    const reason = ANDROID_REASONS[exit.reason];
    if (!reason) return null;
    const crashLog = await adb('logcat', '-b', 'crash', '-d', '-v', 'threadtime').catch(() => '');
    const details = parseAndroidCrashLog(crashLog, pid);
    return {
      kind: reason.kind,
      reason: reason.label,
      detail: [exit.subreason !== 'UNKNOWN' ? exit.subreason : null, exit.description].filter(Boolean).join(' · '),
      title: details.title,
      signal: details.signal,
      thread: details.thread,
      frames: details.frames,
      memoryMb: exit.pssMb,
      at: exit.timestamp,
      pid
    };
  }
  return null;
}

// ---------- iOS ----------

const IOS_REPORT_KINDS = {
  309: { kind: 'crash', label: 'Crash' },
  202: { kind: 'resource', label: 'CPU resource report' },
  145: { kind: 'resource', label: 'Disk writes resource report' },
  385: { kind: 'hang', label: 'Hang' },
  298: { kind: 'oom', label: 'Killed for memory (Jetsam)' }
};

// One .ips report: a JSON header line, then the body (JSON for crashes and Jetsam, text for
// resource reports). Returns null when the report is not about this app.
export function parseIpsReport(text, { bundle, executable }) {
  const newline = text.indexOf('\n');
  const header = JSON.parse(text.slice(0, newline));
  const body = text.slice(newline + 1);
  const type = IOS_REPORT_KINDS[Number(header.bug_type)];
  if (!type) return null;

  if (Number(header.bug_type) === 298) {
    const report = JSON.parse(body);
    const pageSize = report.pageSize ?? 16384;
    const killed = (report.processes ?? []).find(
      process => process.reason && (process.name === executable || process.name === header.app_name)
    );
    if (!killed) return null;
    return {
      kind: type.kind,
      reason: type.label,
      detail: `${killed.reason}; largest process: ${report.largestProcess ?? '–'}`,
      title: null,
      frames: [],
      memoryMb: Math.round(((killed.rpages ?? 0) * pageSize) / 1048576),
      at: header.timestamp
    };
  }

  if (header.bundleID !== bundle) return null;

  if (Number(header.bug_type) === 309) {
    const report = JSON.parse(body);
    const thread = report.threads?.[report.faultingThread ?? -1];
    const images = report.usedImages ?? [];
    const frames = (thread?.frames ?? []).slice(0, 10).map(frame => {
      const image = images[frame.imageIndex]?.name ?? '?';
      return frame.symbol ? `${image} ${frame.symbol}` : `${image} +${frame.imageOffset}`;
    });
    const exception = report.exception ?? {};
    const termination = report.termination ?? {};
    return {
      kind: type.kind,
      reason: `${type.label}: ${exception.type ?? '?'}${exception.signal ? ` (${exception.signal})` : ''}`,
      detail: [termination.namespace, ...(termination.reasons ?? []).slice(0, 2)].filter(Boolean).join(' · '),
      title: report.asi ? Object.values(report.asi).flat().join(' ') : exception.subtype ?? null,
      thread: thread?.name ?? thread?.queue ?? null,
      frames,
      memoryMb: null,
      at: header.timestamp
    };
  }

  // Resource and hang reports are text: keep the lines that say what happened.
  const pick = label => body.match(new RegExp(`^${label}:\\s+(.*)$`, 'm'))?.[1] ?? null;
  return {
    kind: type.kind,
    reason: type.label,
    detail: [pick('Event'), pick('Action taken') && `action taken: ${pick('Action taken')}`].filter(Boolean).join(' · '),
    title: pick('CPU') ?? pick('Writes caused') ?? null,
    frames: [],
    memoryMb: null,
    at: header.timestamp,
    // "Action taken: none" means iOS only reported it; the app kept running.
    fatal: !/^none/i.test(pick('Action taken') ?? '')
  };
}

const devicectl = async (...command) => {
  const output = path.join(os.tmpdir(), `perf-devicectl-${process.pid}-${Date.now()}.json`);
  try {
    await execFileAsync('xcrun', ['devicectl', ...command, '--json-output', output], { maxBuffer: 16 * 1024 * 1024 });
    return JSON.parse(fs.readFileSync(output, 'utf8')).result;
  } finally {
    fs.rmSync(output, { force: true });
  }
};

// Polls a real device for new reports. Reports that were already there when it started are
// skipped, so only what happens during this server run is reported.
export function startIosCrashWatcher({ target, cacheDir, onReport, intervalMs = 20000 }) {
  let seen = null;
  let stopped = false;
  let running = false;

  const poll = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const result = await devicectl('device', 'info', 'files', '--device', target.udid, '--domain-type', 'systemCrashLogs');
      const files = (result.files ?? []).filter(file => !file.resources?.isDirectory && file.name.endsWith('.ips'));
      if (!seen) {
        seen = new Set(files.map(file => file.relativePath));
        return;
      }
      const prefixes = [target.executable, 'JetsamEvent'].filter(Boolean);
      for (const file of files) {
        if (seen.has(file.relativePath)) continue;
        seen.add(file.relativePath);
        if (!prefixes.some(prefix => path.basename(file.relativePath).startsWith(prefix))) continue;
        const destination = path.join(cacheDir, path.basename(file.relativePath));
        fs.mkdirSync(cacheDir, { recursive: true });
        await devicectl(
          'device', 'copy', 'from', '--device', target.udid, '--domain-type', 'systemCrashLogs',
          '--source', file.relativePath, '--destination', destination
        );
        const report = parseIpsReport(fs.readFileSync(destination, 'utf8'), target);
        if (report) onReport({ ...report, file: destination });
      }
    } catch (error) {
      if (!/locked|not connected|unavailable/i.test(String(error))) console.warn(`iOS crash logs: ${error.message}`);
    } finally {
      running = false;
    }
  };

  poll();
  const timer = setInterval(poll, intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
