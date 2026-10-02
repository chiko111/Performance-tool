// iOS side of the automatic before/after tests. Capture: the native probe inside the probe build
// reports every finished gesture (POST /gesture). Replay: a small XCUITest runner from
// ~/perf-tool/ios/replay drives the installed app by bundle id, so nothing is added to the project.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const TAP_MAX_MOVE_PT = 10;
const TAP_MAX_MS = 400;
const MIN_SPEED = 200; // points per second
const MAX_SPEED = 8000;

const safeName = name => String(name || 'scenario').replace(/[^\w.-]+/g, '_').slice(0, 60);

export async function restartIosApp(target) {
  if (target.kind === 'simulator') {
    await execFileAsync('xcrun', ['simctl', 'launch', '--terminate-running-process', target.udid, target.bundle]);
  } else {
    await execFileAsync('xcrun', ['devicectl', 'device', 'process', 'launch', '--device', target.udid, '--terminate-existing', target.bundle]);
  }
  return Date.now();
}

// Raw probe gestures → the same kinds the Android capture produces. Swipes keep the faster of the
// average and the release speed, which is what decides how far a list keeps scrolling.
function classify(raw) {
  const moved = Math.hypot(raw.x2 - raw.x1, raw.y2 - raw.y1);
  if (moved <= TAP_MAX_MOVE_PT) {
    return raw.durationMs <= TAP_MAX_MS
      ? { type: 'tap', at: raw.at, x: raw.x1, y: raw.y1 }
      : { type: 'longpress', at: raw.at, x: raw.x1, y: raw.y1, durationMs: raw.durationMs };
  }
  const average = moved / Math.max(0.05, raw.durationMs / 1000);
  const velocity = Math.round(Math.min(MAX_SPEED, Math.max(MIN_SPEED, average, raw.releaseSpeed ?? 0)));
  return { type: 'swipe', at: raw.at, x1: raw.x1, y1: raw.y1, x2: raw.x2, y2: raw.y2, durationMs: raw.durationMs, velocity };
}

export async function startIosCapture({ name, target, resultsDir, scenarioFile, start }) {
  const startedAt = Date.now();
  const gestures = [];
  let device = null;
  return {
    name: safeName(name),
    platform: 'ios',
    startedAt,
    // Timed on the Mac clock (arrival minus duration), so the phone's clock does not matter.
    add(raw, receivedAt) {
      const at = Math.round(receivedAt - raw.durationMs - startedAt);
      if (at < 0) return;
      device ??= raw.device;
      gestures.push(classify({ ...raw, at }));
    },
    stop() {
      const scenario = {
        name: safeName(name),
        platform: 'ios',
        packageName: target.bundle,
        start,
        device: device ?? { model: target.name, width: 0, height: 0, density: 1 },
        createdAt: Date.now(),
        durationMs: Date.now() - startedAt,
        gestures: gestures.sort((a, b) => a.at - b.at)
      };
      fs.mkdirSync(path.dirname(scenarioFile(resultsDir, scenario.name)), { recursive: true });
      fs.writeFileSync(scenarioFile(resultsDir, scenario.name), JSON.stringify(scenario, null, 2));
      return scenario;
    }
  };
}

// Built once per simulator / signing team; later runs only execute it.
export async function ensureRunner({ target, toolRoot, cacheDir, onStep }) {
  // A changed runner source gets a new build instead of a stale cached one.
  const source = ['ios/replay/PerfReplay/PerfReplayTests.swift', 'ios/replay/PerfReplay.xcodeproj/project.pbxproj']
    .map(file => fs.readFileSync(path.join(toolRoot, file)))
    .reduce((hash, content) => hash.update(content), crypto.createHash('sha1'))
    .digest('hex')
    .slice(0, 8);
  const key = `${target.kind === 'simulator' ? 'simulator' : `device-${target.team || 'noteam'}`}-${source}`;
  const derivedData = path.join(cacheDir, `replay-${key}`);
  const products = path.join(derivedData, 'Build', 'Products');
  const existing = () =>
    fs.existsSync(products) ? fs.readdirSync(products).find(file => file.endsWith('.xctestrun')) : undefined;
  if (existing()) return path.join(products, existing());

  onStep?.('Building the iOS replay runner (first time only, about a minute)');
  const args = [
    'build-for-testing',
    '-project', path.join(toolRoot, 'ios/replay/PerfReplay.xcodeproj'),
    '-scheme', 'PerfReplay',
    '-destination', target.kind === 'simulator' ? 'generic/platform=iOS Simulator' : `id=${target.udid}`,
    '-derivedDataPath', derivedData
  ];
  if (target.kind !== 'simulator') {
    if (!target.team) throw new Error('No signing team for the replay runner: pass --team to perf ios');
    // App ids are unique across teams: one per team keeps two developers from colliding.
    args.push('-allowProvisioningUpdates', `DEVELOPMENT_TEAM=${target.team}`, `PRODUCT_BUNDLE_IDENTIFIER=dev.perftool.replay.t${target.team.toLowerCase()}`);
  }
  const log = path.join(cacheDir, `replay-${key}-build.log`);
  fs.mkdirSync(cacheDir, { recursive: true });
  try {
    const { stdout } = await execFileAsync('xcodebuild', args, { maxBuffer: 64 * 1024 * 1024 });
    fs.writeFileSync(log, stdout);
  } catch (error) {
    fs.writeFileSync(log, `${error.stdout ?? ''}\n${error.stderr ?? ''}`);
    const reason = String(error.stdout ?? '').match(/error: (.+)/)?.[1] ?? 'see the log';
    throw new Error(`Replay runner build failed: ${reason} (${log})`);
  }
  if (!existing()) throw new Error(`Replay runner built but no .xctestrun found in ${products}`);
  return path.join(products, existing());
}

// Runs the scenario once on the app as it is now (already on the start screen): the runner attaches
// to it instead of relaunching. `onLaunch` fires right before the first gesture is timed.
export function replayIos(scenario, { target, xctestrun, onLaunch, onStep, isCancelled }) {
  return new Promise((resolve, reject) => {
    const child = spawn('xcodebuild', ['test-without-building', '-xctestrun', xctestrun, '-destination', `id=${target.udid}`], {
      env: {
        ...process.env,
        TEST_RUNNER_PERF_BUNDLE: target.bundle,
        TEST_RUNNER_PERF_ATTACH: '1',
        TEST_RUNNER_PERF_SCENARIO: Buffer.from(JSON.stringify(scenario)).toString('base64')
      }
    });
    let output = '';
    let buffer = '';
    let cancelled = false;
    const watch = setInterval(() => {
      if (isCancelled() && !cancelled) {
        cancelled = true;
        child.kill('SIGINT');
      }
    }, 250);
    child.stdout.on('data', chunk => {
      output += chunk;
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const step = line.match(/PERF_STEP (.+)$/)?.[1];
        if (!step) continue;
        if (step.startsWith('launching') || step.startsWith('attached')) onLaunch?.();
        else onStep?.(step);
      }
    });
    child.stderr.on('data', chunk => (output += chunk));
    child.on('close', code => {
      clearInterval(watch);
      if (cancelled) return resolve(false);
      if (code === 0) return resolve(true);
      const reason = output.match(/error: (.+)/)?.[1] ?? output.match(/Failing tests:[\s\S]{0,200}/)?.[0] ?? `xcodebuild exited with ${code}`;
      reject(new Error(`Replay failed: ${reason.trim()}`));
    });
  });
}
