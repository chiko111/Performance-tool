// The setup page (http://localhost:8098): pick a project, review what the scan found, fill in the
// rest by hand, save, and get the commands to run. Started by the Perf Tool app or `perf init`.
//   node setup-server.mjs [--repo <path>] [--port 8098] [--exit-when-idle]
// --exit-when-idle: the app has no window of its own, so the server stops a few minutes after the
// last open setup page is closed.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { scanProject, scanTools } from './scan.mjs';
import { readConfig, projectConfig, saveProject, validateProject, commandsFor, ENV_DIR, CONFIG_FILE } from './config.mjs';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const toolRoot = path.resolve(here, '..');
const args = process.argv.slice(2);
const option = name => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
const PORT = Number(option('port') ?? 8098);
const exitWhenIdle = args.includes('--exit-when-idle');
const IDLE_EXIT_MS = 3 * 60 * 1000;
let lastPing = Date.now();

const send = (response, status, body) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
};
const readBody = request =>
  new Promise((resolve, reject) => {
    let data = '';
    request.on('data', chunk => (data += chunk));
    request.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (error) {
        reject(error);
      }
    });
  });

// ---------------------------------------------------------------- native pickers

async function chooseWithFinder(kind, prompt) {
  const script = kind === 'folder' ? `POSIX path of (choose folder with prompt "${prompt}")` : `POSIX path of (choose file with prompt "${prompt}")`;
  try {
    // `tell me` (osascript itself) brings the dialog to the front without asking for Automation
    // access to another app, which a "System Events" call would.
    const { stdout } = await execFileAsync('osascript', ['-e', 'tell me to activate', '-e', script]);
    return stdout.trim().replace(/\/$/, '');
  } catch {
    return null; // cancelled
  }
}

// ---------------------------------------------------------------- perf command on PATH

function installCli() {
  const target = path.join(toolRoot, 'perf');
  fs.chmodSync(target, 0o755);
  const pathDirs = (process.env.PATH ?? '').split(':');
  const candidates = ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local/bin'), path.join(os.homedir(), 'bin')];
  const writable = dir => {
    try {
      fs.accessSync(dir, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  };
  let dir = candidates.find(item => fs.existsSync(item) && writable(item) && pathDirs.includes(item));
  let pathNote = null;
  if (!dir) {
    dir = path.join(os.homedir(), '.local/bin');
    fs.mkdirSync(dir, { recursive: true });
    pathNote = `Add ${dir} to PATH: echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc, then open a new terminal`;
  }
  const link = path.join(dir, 'perf');
  if (fs.existsSync(link) && !fs.lstatSync(link).isSymbolicLink()) {
    throw new Error(`${link} exists and is not perf-tool; rename it and try again`);
  }
  fs.rmSync(link, { force: true });
  fs.symlinkSync(target, link);
  return { link, pathNote };
}

// ---------------------------------------------------------------- updates (the tool is a git clone)

async function git(...command) {
  const { stdout } = await execFileAsync('git', ['-C', toolRoot, ...command], { timeout: 30000 });
  return stdout.trim();
}

async function updateStatus({ fetch = true } = {}) {
  if (!fs.existsSync(path.join(toolRoot, '.git'))) return { state: 'no-git', message: 'This copy of perf-tool is not a git clone, so it cannot update itself' };
  try {
    const remote = await git('remote', 'get-url', 'origin').catch(() => '');
    if (!remote) return { state: 'no-remote', message: 'No git remote set for perf-tool (git remote add origin <url>)' };
    if (fetch) await git('fetch', '--quiet', 'origin');
    const branch = await git('rev-parse', '--abbrev-ref', 'HEAD');
    const upstream = await git('rev-parse', '--abbrev-ref', '@{u}').catch(() => `origin/${branch}`);
    const behind = Number(await git('rev-list', '--count', `HEAD..${upstream}`));
    const current = await git('log', '-1', '--format=%h %cd', '--date=short');
    const changes = behind ? (await git('log', '--format=%s', `HEAD..${upstream}`)).split('\n').slice(0, 10) : [];
    return { state: behind ? 'available' : 'current', behind, current, remote, upstream, changes };
  } catch (error) {
    return { state: 'error', message: `Could not check for updates: ${error.message.split('\n')[0]}` };
  }
}

async function applyUpdate() {
  const dirty = await git('status', '--porcelain', '--untracked-files=no');
  if (dirty) throw new Error('perf-tool has local changes; commit or stash them first (git -C "' + toolRoot + '" status)');
  await git('pull', '--ff-only', '--quiet');
  return updateStatus({ fetch: false });
}

// ---------------------------------------------------------------- project actions

function runInRepo(repo, command, commandArgs) {
  return new Promise(resolve => {
    const child = spawn(command, commandArgs, { cwd: repo, env: process.env });
    let output = '';
    child.stdout.on('data', chunk => (output += chunk));
    child.stderr.on('data', chunk => (output += chunk));
    child.on('error', error => resolve({ ok: false, output: error.message }));
    child.on('close', code => resolve({ ok: code === 0, output: output.split('\n').slice(-40).join('\n') }));
  });
}

const ACTIONS = {
  'yarn-install': repo => (fs.existsSync(path.join(repo, 'yarn.lock')) ? runInRepo(repo, 'yarn', ['install']) : runInRepo(repo, 'npm', ['install'])),
  'pod-install': repo => runInRepo(path.join(repo, 'ios'), 'pod', ['install'])
};

function savePastedEnv(projectName, variantId, content) {
  const dir = path.join(ENV_DIR, projectName.replace(/[^\w.-]+/g, '_'));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${variantId.replace(/[^\w.-]+/g, '_')}.js`);
  fs.writeFileSync(file, content.endsWith('\n') ? content : `${content}\n`, { mode: 0o600 });
  return file;
}

// ---------------------------------------------------------------- server

const routes = {
  'GET /api/state': async () => ({
    tool: toolRoot,
    configFile: CONFIG_FILE,
    initialRepo: option('repo') ? path.resolve(option('repo')) : Object.keys(readConfig().projects)[0] ?? null,
    projects: Object.keys(readConfig().projects),
    update: await updateStatus()
  }),
  'POST /api/choose-folder': async () => ({ path: await chooseWithFinder('folder', 'Choose the React Native project folder') }),
  'POST /api/choose-file': async () => ({ path: await chooseWithFinder('file', 'Choose the env file') }),
  'POST /api/scan': async body => {
    const repo = path.resolve(String(body.repo ?? '').replace(/^~(?=\/|$)/, os.homedir()));
    if (!fs.existsSync(repo)) throw new Error(`Folder not found: ${repo}`);
    const [scan, tools] = await Promise.all([scanProject(repo), scanTools()]);
    return { ...scan, tools, saved: projectConfig(repo) };
  },
  'POST /api/env': async body => ({ path: savePastedEnv(String(body.project), String(body.variant), String(body.content ?? '')) }),
  'POST /api/action': async body => {
    const action = ACTIONS[body.action];
    if (!action) throw new Error(`Unknown action '${body.action}'`);
    return action(path.resolve(body.repo));
  },
  'POST /api/save': async body => {
    const repo = path.resolve(body.repo);
    const errors = validateProject(body.project);
    if (errors.length) return { ok: false, errors };
    saveProject(repo, body.project);
    const cli = installCli();
    return { ok: true, repo, cli, commands: commandsFor(body.project) };
  },
  // perf web without a Terminal: runs in the background, logs to the project's cache folder; the
  // dashboard's Stop ends it.
  'POST /api/start-web': async body => {
    const repo = path.resolve(String(body.repo ?? ''));
    const project = projectConfig(repo);
    if (project?.kind !== 'web') throw new Error('Save the web project first');
    const logDir = path.join(os.homedir(), 'Library', 'Caches', 'perf-tool', path.basename(repo));
    fs.mkdirSync(logDir, { recursive: true });
    const log = path.join(logDir, 'perf-web.log');
    const output = fs.openSync(log, 'w');
    const child = spawn(path.join(toolRoot, 'perf'), ['web', '--repo', repo, ...(body.variant ? ['--variant', String(body.variant)] : [])], {
      cwd: repo,
      detached: true,
      stdio: ['ignore', output, output],
      env: process.env
    });
    child.unref();
    fs.closeSync(output);
    return { started: true, log };
  },
  'GET /api/update': () => updateStatus(),
  'POST /api/update': () => applyUpdate(),
  'POST /api/ping': async () => {
    lastPing = Date.now();
    return { ok: true };
  },
  'POST /api/quit': async () => {
    setTimeout(() => process.exit(0), 200);
    return { ok: true };
  }
};

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://localhost:${PORT}`);
  // Only this machine's own pages may call the API (the page is served from localhost).
  const origin = request.headers.origin;
  if (origin && !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) return send(response, 403, { error: 'forbidden' });
  if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/setup')) {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return response.end(fs.readFileSync(path.join(here, 'setup.html')));
  }
  const route = routes[`${request.method} ${url.pathname}`];
  if (!route) return send(response, 404, { error: 'not found' });
  try {
    lastPing = Date.now();
    send(response, 200, await route(request.method === 'POST' ? await readBody(request) : {}));
  } catch (error) {
    send(response, 400, { error: error.message });
  }
});

server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? `Port ${PORT} is in use (setup page already open?)` : error.message);
  process.exit(error.code === 'EADDRINUSE' ? 3 : 1);
});
server.listen(PORT, '127.0.0.1', () => console.log(`Setup: http://localhost:${PORT}`));

if (exitWhenIdle) {
  setInterval(() => {
    if (Date.now() - lastPing > IDLE_EXIT_MS) process.exit(0);
  }, 30000).unref();
}
