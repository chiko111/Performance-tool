// Records what a person does on an Android device as a list of gestures (tap, long press, swipe,
// with the pause before each) and plays the same list back over adb, so a before and an after
// build are driven through exactly the same scenario.
//
// Capture reads the touchscreen with `getevent` (outside the app, nothing is added to it) from the
// screen the person is on; replay uses `input tap|swipe` once the server has restarted the app and
// brought it back to that screen.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const adb = async (...command) => {
  try {
    return (await execFileAsync('adb', command, { maxBuffer: 16 * 1024 * 1024 })).stdout;
  } catch (error) {
    if (/no devices|device offline|unauthorized/.test(String(error.stderr ?? error))) {
      throw new Error('No Android device connected (or not authorised for USB debugging)');
    }
    throw error;
  }
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));

const TAP_MAX_MOVE_DP = 10;
const TAP_MAX_MS = 400;
const MIN_SWIPE_MS = 60;

export const scenarioDir = resultsDir => path.join(resultsDir, 'scenarios');
const safeName = name => String(name || 'scenario').replace(/[^\w.-]+/g, '_').slice(0, 60);
export const scenarioFile = (resultsDir, name) => path.join(scenarioDir(resultsDir), `${safeName(name)}.json`);

export function listScenarios(resultsDir) {
  const dir = scenarioDir(resultsDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(file => file.endsWith('.json'))
    .map(file => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')))
    .map(({ name, platform = 'android', start, device, gestures, durationMs, createdAt, packageName }) => ({
      name,
      platform,
      start: start?.screen ?? null,
      device,
      packageName,
      gestures: gestures.length,
      durationSec: Math.round(durationMs / 1000),
      createdAt
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function loadScenario(resultsDir, name) {
  const file = scenarioFile(resultsDir, name);
  if (!fs.existsSync(file)) throw new Error(`Unknown scenario '${name}'`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function deviceInfo() {
  const [size, density, model] = await Promise.all([
    adb('shell', 'wm', 'size'),
    adb('shell', 'wm', 'density'),
    adb('shell', 'getprop', 'ro.product.model')
  ]);
  // An override (display size changed in settings) is what apps and `input` use.
  const pick = (text, pattern) => [...text.matchAll(pattern)].map(match => match.slice(1).map(Number)).at(-1);
  const [width, height] = pick(size, /(\d+)x(\d+)/g);
  const [dpi] = pick(density, /(\d+)/g);
  return { model: model.trim(), width, height, density: dpi / 160 };
}

// The touchscreen reports multi-touch positions and is a direct input (finger on the display).
// Some phones list other multi-touch devices first, e.g. Samsung's "sec_touchpad" (a pointer
// device that never sees screen touches), so direct devices and "touchscreen" names win.
async function touchscreen() {
  const out = await adb('shell', 'getevent', '-pl');
  const candidates = out
    .split(/(?=add device \d+:)/)
    .map(block => ({
      device: block.match(/add device \d+: (\S+)/)?.[1],
      name: block.match(/name:\s+"([^"]*)"/)?.[1] ?? '',
      maxX: Number(block.match(/ABS_MT_POSITION_X\s*:.*?max (\d+)/)?.[1]),
      maxY: Number(block.match(/ABS_MT_POSITION_Y\s*:.*?max (\d+)/)?.[1]),
      direct: /INPUT_PROP_DIRECT/.test(block)
    }))
    .filter(candidate => candidate.device && candidate.maxX && candidate.maxY);
  const score = candidate => (candidate.direct ? 2 : 0) + (/touch\s*screen|_ts\b|touchscreen/i.test(candidate.name) ? 1 : 0);
  const best = candidates.sort((a, b) => score(b) - score(a))[0];
  if (!best) throw new Error('No touchscreen found (adb shell getevent -pl)');
  // The emulator lists one identical multi-touch device per possible display
  // (virtio_input_multi_touch_1…11); only one of them receives the clicks.
  return candidates.filter(candidate => score(candidate) === score(best));
}

// Reads every equally good touch device and keeps the first one that reports a touch.
function createTouchRouter(touchscreens, createParser) {
  if (touchscreens.length === 1) {
    const [touch] = touchscreens;
    const parser = createParser(touch);
    return { args: [touch.device], touch: () => touch, line: parser.line, result: parser.result };
  }
  const byDevice = new Map(touchscreens.map(touch => [touch.device, touch]));
  let lockedTouch = null;
  let parser = null;
  return {
    args: [],
    touch: () => lockedTouch,
    line(text) {
      const device = text.match(/^(?:\[[^\]]*\]\s+)?(\/dev\/input\/event\d+):/)?.[1];
      if (!device || !byDevice.has(device)) return;
      if (!lockedTouch) {
        if (!/EV_ABS\s+ABS_MT_/.test(text)) return;
        lockedTouch = byDevice.get(device);
        parser = createParser(lockedTouch);
      }
      if (device === lockedTouch.device) parser.line(text);
    },
    result: () => (parser ? parser.result() : [])
  };
}

export async function restartApp(packageName) {
  await adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP').catch(() => {});
  await adb('shell', 'am', 'force-stop', packageName);
  await adb('shell', 'monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1');
  return Date.now();
}

// Turns the raw multi-touch stream of the first finger into gestures.
function createGestureParser({ maxX, maxY, width, height, density, startedAt }) {
  const gestures = [];
  let clockOffset = null; // host ms - kernel ms, smallest seen (least transport delay)
  let touch = null;
  let current = {}; // last reported position: a frame only carries the coordinates that changed
  let slot = 0;
  const toPx = (value, max, size) => Math.round((value / (max + 1)) * size);

  const finish = kernelMs => {
    const { downAt, x1, y1, x2, y2 } = touch;
    touch = null;
    if (x1 == null || y1 == null) return;
    const durationMs = Math.round(kernelMs - downAt);
    const moved = Math.hypot(x2 - x1, y2 - y1) / density;
    const at = downAt; // kernel time; converted with the final clock offset in result()
    if (moved <= TAP_MAX_MOVE_DP) {
      gestures.push(durationMs <= TAP_MAX_MS ? { type: 'tap', at, x: x1, y: y1 } : { type: 'longpress', at, x: x1, y: y1, durationMs });
    } else {
      gestures.push({ type: 'swipe', at, x1, y1, x2, y2, durationMs: Math.max(MIN_SWIPE_MS, durationMs) });
    }
  };

  return {
    // Gesture times relative to the app launch, all converted with the same (best) clock offset.
    result: () => gestures.map(gesture => ({ ...gesture, at: Math.max(0, Math.round(gesture.at + clockOffset - startedAt)) })),
    line(text) {
      const match = text.match(/\[\s*([\d.]+)\]\s+(?:\S+:\s+)?(EV_\w+)\s+(\S+)\s+(\S+)/);
      if (!match) return;
      const [, seconds, type, code, raw] = match;
      const kernelMs = Number(seconds) * 1000;
      const offset = Date.now() - kernelMs;
      clockOffset = clockOffset == null ? offset : Math.min(clockOffset, offset);
      if (code === 'ABS_MT_SLOT') slot = parseInt(raw, 16);
      // BTN_TOUCH covers screens that report no tracking ids; with them both mark the same moment.
      const down = (code === 'ABS_MT_TRACKING_ID' && slot === 0 && raw !== 'ffffffff') || (code === 'BTN_TOUCH' && raw === 'DOWN');
      const up = (code === 'ABS_MT_TRACKING_ID' && slot === 0 && raw === 'ffffffff') || (code === 'BTN_TOUCH' && raw === 'UP');
      if (down && !touch) touch = { downAt: kernelMs };
      if (up && touch) finish(kernelMs);
      if (slot !== 0) return;
      if (code === 'ABS_MT_POSITION_X') current.x = toPx(parseInt(raw, 16), maxX, width);
      if (code === 'ABS_MT_POSITION_Y') current.y = toPx(parseInt(raw, 16), maxY, height);
      if (type === 'EV_SYN' && code === 'SYN_REPORT' && touch && current.x != null && current.y != null) {
        touch.x2 = current.x;
        touch.y2 = current.y;
        touch.x1 ??= current.x;
        touch.y1 ??= current.y;
      }
    }
  };
}

export async function startCapture({ name, packageName, resultsDir, start }) {
  const [screen, touchscreens] = await Promise.all([deviceInfo(), touchscreen()]);
  const startedAt = Date.now();
  const router = createTouchRouter(touchscreens, touch => createGestureParser({ ...touch, ...screen, startedAt }));
  const process = spawn('adb', ['shell', 'getevent', '-lt', ...router.args]);
  let buffer = '';
  process.stdout.on('data', chunk => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    lines.forEach(router.line);
  });

  return {
    name: safeName(name),
    startedAt,
    stop() {
      process.kill();
      const scenario = {
        name: safeName(name),
        platform: 'android',
        packageName,
        start,
        touchDevice: router.touch()
          ? `${router.touch().device} (${router.touch().name})`
          : touchscreens.map(touch => touch.device).join(', '),
        device: screen,
        createdAt: Date.now(),
        durationMs: Date.now() - startedAt,
        gestures: router.result()
      };
      fs.mkdirSync(scenarioDir(resultsDir), { recursive: true });
      fs.writeFileSync(scenarioFile(resultsDir, scenario.name), JSON.stringify(scenario, null, 2));
      return scenario;
    }
  };
}

const describe = gesture =>
  gesture.type === 'swipe'
    ? `swipe ${gesture.x1},${gesture.y1} → ${gesture.x2},${gesture.y2} (${gesture.durationMs} ms)`
    : `${gesture.type} ${gesture.x},${gesture.y}`;

// Plays a scenario on the app as it is now (the server has already restarted it and opened the
// start screen). `onStart` runs right before the first gesture is due (start the recording there);
// the promise resolves once the scenario's recorded length has passed.
export async function replay(scenario, { onStart, onStep, isCancelled }) {
  const screen = await deviceInfo();
  const scaleX = screen.width / scenario.device.width;
  const scaleY = screen.height / scenario.device.height;
  const x = value => Math.round(value * scaleX);
  const y = value => Math.round(value * scaleY);

  // `input` starts a VM for every command; issuing each gesture that much earlier keeps the
  // gesture itself on its recorded time.
  const probeStart = Date.now();
  await adb('shell', 'input', 'keyevent', 'KEYCODE_UNKNOWN');
  const commandDelay = Date.now() - probeStart;

  const startedAt = Date.now();
  onStart?.();
  for (const [index, gesture] of scenario.gestures.entries()) {
    if (isCancelled()) return false;
    await sleep(startedAt + gesture.at - commandDelay - Date.now());
    onStep?.(`${index + 1}/${scenario.gestures.length}: ${describe(gesture)}`);
    if (gesture.type === 'tap') await adb('shell', 'input', 'tap', x(gesture.x), y(gesture.y));
    else if (gesture.type === 'longpress')
      await adb('shell', 'input', 'swipe', x(gesture.x), y(gesture.y), x(gesture.x), y(gesture.y), gesture.durationMs);
    else
      await adb('shell', 'input', 'swipe', x(gesture.x1), y(gesture.y1), x(gesture.x2), y(gesture.y2), gesture.durationMs);
  }
  while (!isCancelled() && Date.now() < startedAt + scenario.durationMs) await sleep(250);
  return !isCancelled();
}
