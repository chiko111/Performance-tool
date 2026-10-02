// Reads a build's output on stdin, saves it to --log and shows the progress: one updating line in
// the terminal and a bar on the dashboard (POST /build). Only errors and the result are printed.
//   Android: Gradle's own percentage (`--console=rich`, which keeps it when the output is piped).
//   iOS: xcodebuild has none, so finished tasks are counted against the last successful build.
import fs from 'node:fs';

const args = process.argv.slice(2);
const option = name => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
const platform = option('platform');
const logFile = option('log');
const historyFile = option('history');
const dashboard = option('dashboard');

const readHistory = () => {
  try {
    return JSON.parse(fs.readFileSync(historyFile, 'utf8'));
  } catch {
    return {};
  }
};
const previous = readHistory()[platform];
const startedAt = Date.now();
const log = fs.createWriteStream(logFile);
const tty = process.stderr.isTTY;

let percent = null;
let step = 'Starting';
let tasks = 0;
let result = null; // 'done' | 'failed'
let failure = [];
let inFailure = false;

const elapsed = () => {
  const seconds = Math.round((Date.now() - startedAt) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};
const statusLine = () => {
  const share = percent == null ? `${tasks} tasks` : `${percent}%`;
  return `Build ${platform}: ${share} · ${elapsed()} · ${step}`;
};

let shown = false;
const clearLine = () => {
  if (tty && shown) process.stderr.write('\r\x1b[2K');
  shown = false;
};
const draw = () => {
  if (!tty) return;
  const width = (process.stderr.columns || 100) - 1;
  process.stderr.write(`\r\x1b[2K${statusLine().slice(0, width)}`);
  shown = true;
};
const print = text => {
  clearLine();
  console.log(text);
  draw();
};

let lastPost = 0;
const post = (force = false) => {
  if (!dashboard || (!force && Date.now() - lastPost < 1000)) return Promise.resolve();
  lastPost = Date.now();
  const body = { platform, percent, step, tasks, startedAt, state: result ?? 'running', seconds: Math.round((Date.now() - startedAt) / 1000) };
  return fetch(`${dashboard}/build`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
};

const IOS_TASK = /^([A-Z][A-Za-z0-9]+) .*\(in target '([^']+)' from project/;
const IOS_SCRIPT = /^PhaseScriptExecution (.+?) \//;

function iosLine(line) {
  const task = line.match(IOS_TASK);
  if (task) {
    tasks += 1;
    const script = line.match(IOS_SCRIPT)?.[1]?.replace(/\\(.)/g, '$1');
    step = script ? `${script} (${task[2]})` : `${task[1]} · ${task[2]}`;
    // Never 100% before xcodebuild says so: this build can have more tasks than the last one.
    if (previous?.tasks) percent = Math.min(99, Math.floor((tasks / previous.tasks) * 100));
  }
  if (/: error:/.test(line)) print(line);
  if (/\*\* BUILD SUCCEEDED \*\*/.test(line)) result = 'done';
  if (/\*\* BUILD FAILED \*\*/.test(line)) result = 'failed';
}

function androidLine(line) {
  const progress = [...line.matchAll(/(\d+)% (INITIALIZING|CONFIGURING|EXECUTING)/g)].at(-1);
  if (progress) {
    percent = Number(progress[1]);
    if (progress[2] !== 'EXECUTING') step = progress[2].toLowerCase();
  }
  const task = line.match(/> (:[\w:.-]+)/)?.[1];
  if (task) step = task;
  if (/^> Task /.test(line)) tasks += 1;
  if (/^e: |error:/.test(line)) print(line);
  if (/BUILD SUCCESSFUL/.test(line)) result = 'done';
  if (/BUILD FAILED|FAILURE: Build failed/.test(line)) result = 'failed';
  // Gradle's explanation of a failure, printed in full at the end.
  if (/^\* What went wrong:/.test(line)) inFailure = true;
  else if (/^\* (Try|Get more help)/.test(line)) inFailure = false;
  if (inFailure) failure.push(line);
}

const handle = platform === 'android' ? androidLine : iosLine;
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  // Colours are dropped; cursor moves (Gradle redrawing its status area) end a line.
  const text = buffer + chunk.replace(/\x1b\[[0-9;?]*m/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]|\r/g, '\n');
  const lines = text.split('\n');
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    log.write(`${line}\n`);
    handle(line);
  }
  draw();
  post();
});

const ticker = setInterval(draw, 1000);

process.stdin.on('end', async () => {
  clearInterval(ticker);
  if (buffer.trim()) {
    log.write(`${buffer}\n`);
    handle(buffer);
  }
  result ??= 'failed';
  if (result === 'done') percent = 100;
  clearLine();
  if (failure.length) console.log(failure.join('\n'));
  console.log(result === 'done' ? `BUILD SUCCEEDED in ${elapsed()}` : `BUILD FAILED after ${elapsed()} (log: ${logFile})`);
  if (result === 'done' && historyFile) {
    const history = readHistory();
    history[platform] = { tasks, seconds: Math.round((Date.now() - startedAt) / 1000) };
    fs.writeFileSync(historyFile, JSON.stringify(history, null, 2));
  }
  await post(true);
  log.end();
});
