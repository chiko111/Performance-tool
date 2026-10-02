#!/usr/bin/env node
// Summarises an Instruments .trace (Time Profiler [+ Hitches]) recorded from the app:
// CPU per thread, Hermes GC time, Yoga layout time, top functions, per-second timeline, hitches.
// Usage:
//   node ios-analyze.mjs <file.trace> [--process <name-substring>] [--out summary.json]
//   node ios-analyze.mjs --compare <before.json> <after.json>

import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = name => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const GC_FRAME = /hermes::vm::(HadesGC|GCBase|HeapSnapshot|.*::collect|.*youngGen|.*oldGen)|HadesGC/i;
const YOGA_FRAME = /facebook::yoga::|YGNode|yoga::calculateLayout/;
const SYSTEM_PROCESSES = /^(kernel_task|DTServiceHub|backboardd|SpringBoard|mediaserverd|launchd|logd|symptomsd|mDNSResponder|runningboardd|WindowServer)\b/;

const decode = text =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

const threadLabel = fmt => {
  const name = decode(fmt).replace(/\s+0x[0-9a-f]+\s*\(.*$/i, '').trim();
  return /^Thread$/i.test(name) || name === '' ? '(unnamed threads)' : name;
};

const processLabel = fmt => decode(fmt).replace(/\s*\(\d+\)\s*$/, '').trim();

function exportTable(tracePath, schema) {
  return spawn('xcrun', [
    'xctrace',
    'export',
    '--input',
    tracePath,
    '--xpath',
    `/trace-toc/run[@number="1"]/data/table[@schema="${schema}"]`
  ]);
}

function tableSchemas(tracePath) {
  const toc = execFileSync('xcrun', ['xctrace', 'export', '--input', tracePath, '--toc'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
  return [...new Set([...toc.matchAll(/schema="([^"]+)"/g)].map(match => match[1]))];
}

// xctrace dedupes every element: the first occurrence has id="N", later ones are <tag ref="N"/>.
async function readRows(tracePath, schema, onRow) {
  const child = exportTable(tracePath, schema);
  let buffer = '';
  for await (const chunk of child.stdout) {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('</row>')) !== -1) {
      onRow(buffer.slice(buffer.indexOf('<row>'), end));
      buffer = buffer.slice(end + 6);
    }
  }
}

async function analyzeTimeProfile(tracePath, processHint) {
  const processes = new Map(); // id -> name
  const threads = new Map(); // id -> { name, processId }
  const weights = new Map(); // id -> ns
  const frames = new Map(); // id -> name
  const backtraces = new Map(); // id -> { leaf, gc, yoga }
  const samplesByProcess = new Map(); // process name -> rows

  await readRows(tracePath, 'time-profile', row => {
    for (const match of row.matchAll(/<process id="(\d+)" fmt="([^"]*)"/g)) {
      processes.set(match[1], processLabel(match[2]));
    }

    let threadId;
    const threadDef = row.match(/<thread id="(\d+)" fmt="([^"]*)">([\s\S]*?)<\/thread>/);
    if (threadDef) {
      threadId = threadDef[1];
      const owner = threadDef[3].match(/<process (?:id|ref)="(\d+)"/);
      threads.set(threadId, { name: threadLabel(threadDef[2]), processId: owner?.[1] });
    } else {
      threadId = row.match(/<thread ref="(\d+)"/)?.[1];
    }

    let weightNs;
    const weightDef = row.match(/<weight id="(\d+)"[^>]*>(\d+)<\/weight>/);
    if (weightDef) {
      weightNs = Number(weightDef[2]);
      weights.set(weightDef[1], weightNs);
    } else {
      weightNs = weights.get(row.match(/<weight ref="(\d+)"/)?.[1]) ?? 1e6;
    }

    let backtrace;
    const backtraceDef = row.match(/<backtrace id="(\d+)"[^>]*>([\s\S]*?)<\/backtrace>/);
    if (backtraceDef) {
      const names = [];
      for (const frame of backtraceDef[2].matchAll(/<frame (id|ref)="(\d+)"(?: name="([^"]*)")?/g)) {
        if (frame[1] === 'id') frames.set(frame[2], decode(frame[3] ?? '?'));
        names.push(frames.get(frame[2]) ?? '?');
      }
      backtrace = {
        leaf: names[0] ?? '?',
        gc: names.some(name => GC_FRAME.test(name)),
        yoga: names.some(name => YOGA_FRAME.test(name))
      };
      backtraces.set(backtraceDef[1], backtrace);
    } else {
      backtrace = backtraces.get(row.match(/<backtrace ref="(\d+)"/)?.[1]);
    }

    const timeNs = Number(row.match(/<sample-time[^>]*>(\d+)</)?.[1] ?? 0);
    const thread = threads.get(threadId);
    const processName = processes.get(thread?.processId) ?? '?';
    if (!samplesByProcess.has(processName)) samplesByProcess.set(processName, []);
    samplesByProcess.get(processName).push({ timeNs, weightNs, thread: thread?.name ?? '?', backtrace });
  });

  const candidates = [...samplesByProcess.keys()].filter(name =>
    processHint ? name.toLowerCase().includes(processHint.toLowerCase()) : !SYSTEM_PROCESSES.test(name)
  );
  const totalOf = name => samplesByProcess.get(name).reduce((sum, sample) => sum + sample.weightNs, 0);
  const target = candidates.sort((a, b) => totalOf(b) - totalOf(a))[0];
  if (!target) throw new Error(`No samples for process matching "${processHint ?? '(app)'}"`);

  const samples = samplesByProcess.get(target);
  const startNs = Math.min(...samples.map(sample => sample.timeNs));
  const endNs = Math.max(...samples.map(sample => sample.timeNs));
  const seconds = Math.max(1, Math.ceil((endNs - startNs) / 1e9));

  const perThread = new Map();
  const perFunction = new Map();
  const timeline = Array.from({ length: seconds }, () => ({ total: 0, gc: 0, threads: {} }));
  let gcNs = 0;
  let yogaNs = 0;
  const gcByThread = new Map();

  for (const sample of samples) {
    const bucket = timeline[Math.min(seconds - 1, Math.floor((sample.timeNs - startNs) / 1e9))];
    perThread.set(sample.thread, (perThread.get(sample.thread) ?? 0) + sample.weightNs);
    bucket.total += sample.weightNs;
    bucket.threads[sample.thread] = (bucket.threads[sample.thread] ?? 0) + sample.weightNs;
    if (sample.backtrace?.gc) {
      gcNs += sample.weightNs;
      bucket.gc += sample.weightNs;
      gcByThread.set(sample.thread, (gcByThread.get(sample.thread) ?? 0) + sample.weightNs);
    }
    if (sample.backtrace?.yoga) yogaNs += sample.weightNs;
    const leaf = sample.backtrace?.leaf ?? '?';
    perFunction.set(leaf, (perFunction.get(leaf) ?? 0) + sample.weightNs);
  }

  const ms = ns => Math.round(ns / 1e6);
  const percentOfSecond = ns => Math.round(ns / 1e7); // ns per 1s bucket -> % of one core
  const sortDesc = map => [...map.entries()].sort((a, b) => b[1] - a[1]);

  return {
    process: target,
    durationSec: seconds,
    cpuMsTotal: ms(samples.reduce((sum, sample) => sum + sample.weightNs, 0)),
    gcMs: ms(gcNs),
    gcByThreadMs: Object.fromEntries(sortDesc(gcByThread).map(([name, ns]) => [name, ms(ns)])),
    yogaLayoutMs: ms(yogaNs),
    threads: sortDesc(perThread).map(([name, ns]) => ({
      name,
      cpuMs: ms(ns),
      avgCorePct: Math.round((ns / (seconds * 1e9)) * 100),
      peakCorePct: Math.max(...timeline.map(bucket => percentOfSecond(bucket.threads[name] ?? 0)))
    })),
    topFunctions: sortDesc(perFunction)
      .slice(0, 25)
      .map(([name, ns]) => ({ name, selfMs: ms(ns) })),
    timeline: timeline.map((bucket, second) => ({
      second,
      cpuPct: percentOfSecond(bucket.total),
      gcPct: percentOfSecond(bucket.gc),
      threads: Object.fromEntries(
        Object.entries(bucket.threads)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 6)
          .map(([name, ns]) => [name, percentOfSecond(ns)])
      )
    }))
  };
}

// Column layout of the Hitches table differs between Xcode versions, so durations are read generically.
async function analyzeHitches(tracePath, schemas) {
  const schema = schemas.find(name => /^hitches$/i.test(name)) ?? schemas.find(name => /hitch/i.test(name));
  if (!schema) return null;
  const durations = new Map();
  const values = [];
  await readRows(tracePath, schema, row => {
    const def = row.match(/<duration id="(\d+)"[^>]*>(\d+)<\/duration>/);
    if (def) {
      durations.set(def[1], Number(def[2]));
      values.push(Number(def[2]));
      return;
    }
    const ref = row.match(/<duration ref="(\d+)"/);
    if (ref && durations.has(ref[1])) values.push(durations.get(ref[1]));
  });
  const totalMs = Math.round(values.reduce((sum, value) => sum + value, 0) / 1e6);
  return {
    schema,
    count: values.length,
    totalMs,
    worstMs: values.length ? Math.round(Math.max(...values) / 1e6) : 0,
    over100ms: values.filter(value => value > 100e6).length
  };
}

function printSummary(summary) {
  console.log(`\nProcess: ${summary.process}   duration: ${summary.durationSec}s   CPU total: ${summary.cpuMsTotal} ms`);
  console.log(`Hermes GC: ${summary.gcMs} ms  ${JSON.stringify(summary.gcByThreadMs)}`);
  console.log(`Yoga layout: ${summary.yogaLayoutMs} ms`);
  if (summary.hitches) {
    const hitches = summary.hitches;
    console.log(`Hitches: ${hitches.count} (total ${hitches.totalMs} ms, worst ${hitches.worstMs} ms, >100ms: ${hitches.over100ms})`);
  } else {
    console.log('Hitches: not recorded');
  }
  console.log('\nThreads (CPU ms | avg % of a core | peak 1s %):');
  console.table(summary.threads.slice(0, 15));
  console.log('Top functions (self time):');
  console.table(summary.topFunctions.slice(0, 15));
}

function compare(beforePath, afterPath) {
  const before = JSON.parse(readFileSync(beforePath, 'utf8'));
  const after = JSON.parse(readFileSync(afterPath, 'utf8'));
  const delta = (a, b) => {
    if (a == null || b == null) return '';
    if (a === 0) return b === 0 ? '0%' : 'new';
    const pct = Math.round(((b - a) / a) * 100);
    return `${pct > 0 ? '+' : ''}${pct}%`;
  };
  // CPU ms scale with recording length, so threads are compared by average core %.
  const rows = [
    ['duration s', before.durationSec, after.durationSec],
    ['CPU total ms / s', Math.round(before.cpuMsTotal / before.durationSec), Math.round(after.cpuMsTotal / after.durationSec)],
    ['Hermes GC ms / s', +(before.gcMs / before.durationSec).toFixed(1), +(after.gcMs / after.durationSec).toFixed(1)],
    ['Yoga ms / s', +(before.yogaLayoutMs / before.durationSec).toFixed(1), +(after.yogaLayoutMs / after.durationSec).toFixed(1)],
    ['hitches', before.hitches?.count, after.hitches?.count],
    ['hitch total ms', before.hitches?.totalMs, after.hitches?.totalMs],
    ['worst hitch ms', before.hitches?.worstMs, after.hitches?.worstMs]
  ].map(([metric, a, b]) => ({ metric, before: a, after: b, change: delta(a, b) }));
  console.log(`\nBEFORE: ${beforePath}\nAFTER:  ${afterPath}`);
  console.table(rows);

  const names = new Set([...before.threads, ...after.threads].slice(0, 40).map(thread => thread.name));
  const find = (summary, name) => summary.threads.find(thread => thread.name === name);
  console.log('Threads (avg % of a core / peak 1s %):');
  console.table(
    [...names].map(name => {
      const a = find(before, name);
      const b = find(after, name);
      return {
        thread: name,
        'before avg%': a?.avgCorePct ?? 0,
        'after avg%': b?.avgCorePct ?? 0,
        'before peak%': a?.peakCorePct ?? 0,
        'after peak%': b?.peakCorePct ?? 0,
        change: delta(a?.cpuMs / before.durationSec || 0, b?.cpuMs / after.durationSec || 0)
      };
    })
  );
}

async function main() {
  if (args[0] === '--compare') {
    compare(args[1], args[2]);
    return;
  }
  const tracePath = args[0];
  if (!tracePath) {
    console.error('Usage: ios-analyze.mjs <file.trace> [--process name] [--out summary.json]');
    process.exit(1);
  }
  const schemas = tableSchemas(tracePath);
  if (!schemas.includes('time-profile')) throw new Error('Trace has no Time Profiler data');
  const summary = await analyzeTimeProfile(tracePath, flag('--process'));
  summary.hitches = await analyzeHitches(tracePath, schemas);
  summary.trace = tracePath;
  const outPath = flag('--out') ?? tracePath.replace(/\.trace\/?$/, '.json');
  writeFileSync(outPath, JSON.stringify(summary, null, 2));
  printSummary(summary);
  console.log(`Summary saved: ${outPath}`);
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
