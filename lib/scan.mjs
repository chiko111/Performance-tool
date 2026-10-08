// Looks at a React Native project and proposes its perf-tool settings (see config.mjs): entry,
// Metro config, env handling, navigation ref, source folders and one variant per brand / domain,
// each with its iOS scheme, bundle id and team and its Android flavor and package. Everything is
// a proposal: the setup page shows it for review and manual changes.
//   node scan.mjs --repo <path>     prints the result as JSON
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const run = async (command, args, options = {}) => {
  try {
    const { stdout } = await execFileAsync(command, args, { maxBuffer: 64 * 1024 * 1024, timeout: 60000, ...options });
    return stdout;
  } catch {
    return null;
  }
};
const read = file => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};
const exists = file => fs.existsSync(file);
const normalize = text => String(text ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const capitalize = text => text.charAt(0).toUpperCase() + text.slice(1);

// ---------------------------------------------------------------- tools

async function version(command, args, pattern) {
  const out = await run(command, args);
  if (out == null) return null;
  return out.match(pattern)?.[1] ?? out.trim().split('\n')[0];
}

export async function scanTools() {
  const [node, xcode, adb, pod, yarn, npm] = await Promise.all([
    version('node', ['-v'], /v?([\d.]+)/),
    version('xcodebuild', ['-version'], /Xcode ([\d.]+)/),
    version('adb', ['version'], /version ([\d.]+)/),
    version('pod', ['--version'], /([\d.]+)/),
    version('yarn', ['-v'], /([\d.]+)/),
    version('npm', ['-v'], /([\d.]+)/)
  ]);
  // perf web: Chromium browsers give CPU, GC and heap over the DevTools protocol.
  const browsers = ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium'];
  const chrome = browsers.find(name => [path.join('/Applications', `${name}.app`), path.join(os.homedir(), 'Applications', `${name}.app`)].some(exists)) ?? null;
  return { node, toolNode: process.versions.node, xcode, adb, pod, yarn, npm, chrome };
}

// ---------------------------------------------------------------- signing teams

async function profileList() {
  const dirs = [
    path.join(os.homedir(), 'Library/Developer/Xcode/UserData/Provisioning Profiles'),
    path.join(os.homedir(), 'Library/MobileDevice/Provisioning Profiles')
  ];
  const files = dirs.flatMap(dir => (exists(dir) ? fs.readdirSync(dir).filter(file => file.endsWith('.mobileprovision')).map(file => path.join(dir, file)) : []));
  // Read from the XML itself: plutil cannot turn the profile's dates and data into JSON.
  const profiles = await Promise.all(
    files.map(async file => {
      const plist = await run('security', ['cms', '-D', '-i', file]);
      if (!plist) return null;
      const value = key => plist.match(new RegExp(`<key>${key}</key>\\s*<(?:string|date)>([^<]*)<`))?.[1] ?? null;
      const expires = value('ExpirationDate');
      return {
        name: value('Name'),
        teamId: plist.match(/<key>TeamIdentifier<\/key>\s*<array>\s*<string>([^<]+)</)?.[1] ?? null,
        teamName: value('TeamName'),
        appId: value('application-identifier') ?? '',
        expires: expires ? Date.parse(expires) : null
      };
    })
  );
  return profiles.filter(profile => profile?.teamId && (!profile.expires || profile.expires > Date.now()));
}

async function certificateTeams() {
  const identities = (await run('security', ['find-identity', '-v', '-p', 'codesigning'])) ?? '';
  const names = [...identities.matchAll(/"((?:Apple Development|iPhone Developer|Apple Distribution|iPhone Distribution)[^"]*)"/g)].map(match => match[1]);
  const teams = await Promise.all(
    [...new Set(names)].map(async name => {
      const pem = await run('security', ['find-certificate', '-c', name, '-p']);
      if (!pem) return null;
      const subject = await new Promise(resolve => {
        const child = execFile('openssl', ['x509', '-noout', '-subject', '-nameopt', 'multiline'], (error, stdout) => resolve(error ? '' : stdout));
        child.stdin.end(pem);
      });
      const id = subject.match(/organizationalUnitName\s*=\s*(\S+)/)?.[1];
      return id ? { id, name: subject.match(/organizationName\s*=\s*(.+)/)?.[1]?.trim() ?? id, certificate: name } : null;
    })
  );
  return teams.filter(Boolean);
}

export async function scanTeams() {
  const [profiles, certificates] = await Promise.all([profileList(), certificateTeams()]);
  const teams = new Map();
  for (const certificate of certificates) {
    teams.set(certificate.id, { id: certificate.id, name: certificate.name, certificate: true, profiles: 0 });
  }
  for (const profile of profiles) {
    const team = teams.get(profile.teamId) ?? { id: profile.teamId, name: profile.teamName ?? profile.teamId, certificate: false, profiles: 0 };
    team.profiles += 1;
    teams.set(profile.teamId, team);
  }
  return { teams: [...teams.values()], profiles };
}

// A profile for exactly this app wins over a wildcard one.
function teamForBundle(bundleId, profiles) {
  if (!bundleId) return null;
  const exact = profiles.find(profile => profile.appId.endsWith(`.${bundleId}`));
  if (exact) return exact.teamId;
  const wildcard = profiles.find(profile => {
    const pattern = profile.appId.replace(/^[^.]+\./, '');
    return pattern.endsWith('*') && bundleId.startsWith(pattern.slice(0, -1));
  });
  return wildcard?.teamId ?? null;
}

// ---------------------------------------------------------------- iOS

async function scanIos(repo) {
  const iosDir = path.join(repo, 'ios');
  if (!exists(iosDir)) return { workspace: null, schemes: [] };
  const workspaceName = fs.readdirSync(iosDir).find(file => file.endsWith('.xcworkspace'));
  const projectName = fs.readdirSync(iosDir).find(file => file.endsWith('.xcodeproj'));
  const workspace = workspaceName ? path.join('ios', workspaceName) : null;
  // Only the project's own schemes (the workspace also lists one per pod).
  const schemeDirs = projectName
    ? [path.join(iosDir, projectName, 'xcshareddata/xcschemes'), ...(exists(path.join(iosDir, projectName, 'xcuserdata')) ? fs.readdirSync(path.join(iosDir, projectName, 'xcuserdata')).map(user => path.join(iosDir, projectName, 'xcuserdata', user, 'xcschemes')) : [])]
    : [];
  const names = [...new Set(schemeDirs.flatMap(dir => (exists(dir) ? fs.readdirSync(dir).filter(file => file.endsWith('.xcscheme')).map(file => file.replace(/\.xcscheme$/, '')) : [])))];
  const container = workspace ? ['-workspace', path.join(repo, workspace)] : projectName ? ['-project', path.join(iosDir, projectName)] : null;
  const schemes = await Promise.all(
    names.map(async scheme => {
      const out = container && (await run('xcodebuild', [...container, '-scheme', scheme, '-configuration', 'Release', '-showBuildSettings', '-json'], { timeout: 120000 }));
      let settings = null;
      try {
        settings = JSON.parse(out).map(entry => entry.buildSettings).find(item => item.WRAPPER_EXTENSION === 'app');
      } catch {}
      return {
        scheme,
        bundleId: settings?.PRODUCT_BUNDLE_IDENTIFIER ?? null,
        team: settings?.DEVELOPMENT_TEAM || null,
        executable: settings?.EXECUTABLE_NAME ?? null,
        productName: settings?.PRODUCT_NAME ?? null
      };
    })
  );
  return { workspace, schemes: schemes.filter(item => item.bundleId) };
}

// ---------------------------------------------------------------- Android

// The text between the braces that follow `name {`.
function block(source, name) {
  const match = new RegExp(`(?:^|[\\s{])${name}\\s*\\{`, 'm').exec(source);
  if (!match) return null;
  let depth = 0;
  for (let index = match.index + match[0].length - 1; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}' && --depth === 0) return source.slice(match.index + match[0].length, index);
  }
  return null;
}

// Top-level `name { … }` entries of a block, e.g. the flavors inside productFlavors.
function entries(body) {
  const found = [];
  const pattern = /(?:create\(\s*"|register\(\s*"|\b)([A-Za-z][\w]*)"?\)?\s*\{/g;
  let depth = 0;
  let index = 0;
  while (index < body.length) {
    if (depth === 0) {
      pattern.lastIndex = index;
      const match = pattern.exec(body);
      if (!match) break;
      const open = match.index + match[0].length - 1;
      let level = 0;
      let end = open;
      for (; end < body.length; end += 1) {
        if (body[end] === '{') level += 1;
        if (body[end] === '}' && --level === 0) break;
      }
      found.push({ name: match[1], body: body.slice(open + 1, end) });
      index = end + 1;
    }
  }
  return found;
}

const gradleValue = (body, key) => body?.match(new RegExp(`${key}\\s*=?\\s*["']([^"']+)["']`))?.[1] ?? null;

function scanAndroid(repo) {
  const file = ['android/app/build.gradle', 'android/app/build.gradle.kts'].map(name => path.join(repo, name)).find(exists);
  if (!file) return { flavors: [], package: null };
  const source = read(file).replace(/\/\/.*$/gm, '');
  const android = block(source, 'android') ?? source;
  const defaultId = gradleValue(block(android, 'defaultConfig'), 'applicationId');
  const releaseSuffix = gradleValue(block(block(android, 'buildTypes') ?? '', 'release'), 'applicationIdSuffix') ?? '';
  const flavors = entries(block(android, 'productFlavors') ?? '')
    .filter(entry => !['dimension'].includes(entry.name))
    .map(entry => ({
      flavor: capitalize(entry.name),
      package: `${gradleValue(entry.body, 'applicationId') ?? `${defaultId}${gradleValue(entry.body, 'applicationIdSuffix') ?? ''}`}${releaseSuffix}`
    }));
  return { flavors, package: defaultId ? `${defaultId}${releaseSuffix}` : null };
}

// ---------------------------------------------------------------- JS side

function scanEnv(repo, pkg) {
  const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
  if (dependencies['react-native-config']) {
    const files = fs.readdirSync(repo).filter(file => /^\.env(\..+)?$/.test(file) && !/\.example$|\.sample$/.test(file));
    return {
      kind: 'react-native-config',
      module: files.includes('.env') ? '.env' : null,
      variants: files.filter(file => file !== '.env').map(file => ({ id: file.replace(/^\.env\./, ''), file }))
    };
  }
  const moduleFile = ['env.js', 'env.ts', 'src/env.js', 'src/env.ts', 'src/config/env.js', 'src/config/env.ts'].find(file => exists(path.join(repo, file)));
  if (!moduleFile) return { kind: 'none', module: null, variants: [] };
  const dir = path.dirname(moduleFile);
  const extension = path.extname(moduleFile);
  const variants = fs
    .readdirSync(path.join(repo, dir))
    .map(file => file.match(new RegExp(`^env\\.(?:private\\.)?(.+)\\${extension}$`)))
    .filter(match => match && !/^(example|sample|template|d)$/.test(match[1]))
    .map(match => ({ id: match[1], file: path.join(dir, match[0]) }));
  return { kind: 'module', module: moduleFile, variants };
}

function findNavigationRef(repo, sourceDirs) {
  const pattern = /export\s+(?:const|let|var)\s+navigationRef\b/;
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (/^(node_modules|__tests__|__mocks__|\.git)$/.test(entry.name)) continue;
        const found = walk(path.join(dir, entry.name));
        if (found) return found;
      } else if (/\.(jsx?|tsx?)$/.test(entry.name) && pattern.test(read(path.join(dir, entry.name)) ?? '')) {
        return path.join(dir, entry.name);
      }
    }
    return null;
  };
  for (const dir of sourceDirs.filter(item => !item.startsWith('node_modules'))) {
    const found = exists(path.join(repo, dir)) && walk(path.join(repo, dir));
    if (found) return path.relative(repo, found);
  }
  return null;
}

// The app's own code, plus packages that look like in-house code (installed from git, a branch,
// a tag or a local path rather than a version from the registry) and ship a src/ folder.
function scanSourceDirs(repo, pkg) {
  const own = ['src', 'app', 'App'].filter(dir => exists(path.join(repo, dir)));
  const inHouse = Object.entries({ ...pkg.dependencies })
    .filter(([, spec]) => !/^[\^~]?\d|^[<>=*]|^latest$|^npm:/.test(String(spec)))
    .map(([name]) => `node_modules/${name}/src`)
    .filter(dir => exists(path.join(repo, dir)));
  return { sourceDirs: own.length ? own : ['.'], candidates: inHouse };
}

// Which variant the env module currently equals best (the brand a plain build makes). Keys that
// usually name the brand weigh more than others; a tie gives no answer (the setup page asks).
function closestVariant(repo, envModule, variants) {
  // Only exports with a value: empty placeholders are the same in every env file.
  const lines = file => new Set((read(path.join(repo, file)) ?? '').split('\n').map(line => line.trim())
    .filter(line => /^export\s/.test(line) && !/=\s*(''|""|``|null|undefined)?\s*;?$/.test(line)));
  const weight = line => (/\b\w*(SITE|BRAND|TENANT|DOMAIN|FLAVOR|VARIANT)\w*\s*=/i.test(line) ? 3 : 1);
  const current = envModule ? lines(envModule) : new Set();
  const scores = variants
    .filter(variant => variant.env)
    .map(variant => ({ id: variant.id, score: [...lines(variant.env)].filter(line => current.has(line)).reduce((sum, line) => sum + weight(line), 0) }))
    .sort((a, b) => b.score - a.score);
  if (!scores[0]?.score || scores[0].score === scores[1]?.score) return null;
  return scores[0].id;
}

// Pairs each key (a brand name) with the candidate that names it: a word equal to the key wins
// over a word containing it ("Appbrandb" for "brandb"). Words, not the whole text, so that
// "com.app.brand.b" does not match "brandb". A key left over gets the one candidate left over
// (e.g. the base scheme "app" for the brand "branda").
function match(keys, candidates, text) {
  const result = new Map();
  const base = key => key.split(/[.\-_]/)[0];
  const bases = [...new Set(keys.map(base))];
  const words = candidate => text(candidate).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const score = (key, candidate) => {
    const wanted = normalize(key);
    const list = words(candidate);
    return list.includes(wanted) ? 2 : list.some(word => word.includes(wanted)) ? 1 : 0;
  };
  const pairs = bases
    .flatMap(key => candidates.map(candidate => ({ key, candidate, score: score(key, candidate) })))
    .filter(pair => pair.score > 0)
    .sort((a, b) => b.score - a.score);
  const used = new Set();
  for (const pair of pairs) {
    if (result.has(pair.key) || used.has(pair.candidate)) continue;
    result.set(pair.key, pair.candidate);
    used.add(pair.candidate);
  }
  const leftKeys = bases.filter(key => !result.has(key));
  const leftCandidates = candidates.filter(candidate => !used.has(candidate));
  if (leftKeys.length === 1 && leftCandidates.length === 1) result.set(leftKeys[0], leftCandidates[0]);
  return key => result.get(base(key)) ?? null;
}

// ---------------------------------------------------------------- web projects

const CI_FILES = ['.gitlab-ci.yml', 'bitbucket-pipelines.yml', 'azure-pipelines.yml', 'Jenkinsfile', '.circleci/config.yml'];
const CI_DIRS = ['gitlab_builds', '.gitlab', '.github/workflows', 'ci', '.ci'];

function ciFiles(repo) {
  const files = CI_FILES.map(file => path.join(repo, file)).filter(exists);
  for (const dir of CI_DIRS) {
    const full = path.join(repo, dir);
    if (!exists(full)) continue;
    for (const file of fs.readdirSync(full)) if (/\.ya?ml$/.test(file)) files.push(path.join(full, file));
  }
  return files;
}

// Environment variable names the build reads: in the bundler config and the app's sources.
function referencedEnv(repo, configFile, sourceDirs) {
  const names = new Set();
  const collect = text => {
    for (const match of String(text ?? '').matchAll(/(?:process\.env|import\.meta\.env)\.([A-Za-z_][A-Za-z0-9_]*)|(?:process\.env|import\.meta\.env)\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\]|requireEnv\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g)) {
      names.add(match[1] ?? match[2] ?? match[3]);
    }
  };
  if (configFile) collect(read(path.join(repo, configFile)));
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!/^(node_modules|__tests__|__mocks__|\.git|build|dist)$/.test(entry.name)) walk(path.join(dir, entry.name));
      } else if (/\.(jsx?|tsx?|mjs|cjs)$/.test(entry.name)) {
        collect(read(path.join(dir, entry.name)));
      }
    }
  };
  for (const dir of sourceDirs) if (!dir.startsWith('node_modules') && exists(path.join(repo, dir))) walk(path.join(repo, dir));
  return names;
}

// Literal `export NAME=value` (or `NAME: value` under variables:) per CI job; values that come from
// CI secrets ($VAR) are left out — the bundler config usually loads those itself.
function ciEnvSets(repo, wanted) {
  const sets = [];
  for (const file of ciFiles(repo)) {
    let job = null;
    let env = {};
    const flush = () => {
      if (Object.keys(env).length) sets.push({ source: `${path.relative(repo, file)}: ${job ?? '(top)'}`, env });
      env = {};
    };
    for (const line of (read(file) ?? '').split('\n')) {
      const jobMatch = line.match(/^([^\s#][^:]*):\s*$/);
      if (jobMatch) {
        flush();
        job = jobMatch[1].trim();
        continue;
      }
      const exported = line.match(/^\s*-?\s*export\s+([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"$]*)"|'([^']*)'|([^\s"'$][^\s]*))\s*$/);
      if (exported && wanted.has(exported[1])) env[exported[1]] = exported[2] ?? exported[3] ?? exported[4];
    }
    flush();
  }
  return sets;
}

// `export NAME=value && webpack …`, `NAME=value vite build`, `cross-env NAME=value …` in package.json.
function scriptEnvSets(pkg, wanted) {
  const sets = [];
  for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
    if (!/\b(webpack|vite|react-scripts)\b/.test(command)) continue;
    const env = {};
    for (const match of command.matchAll(/(?:export\s+|cross-env\s+|^|&&\s*|;\s*)([A-Za-z_][A-Za-z0-9_]*)=(["']?)([^\s"'&;]+)\2/g)) {
      if (wanted.has(match[1])) env[match[1]] = match[3];
    }
    const mode = command.match(/\bvite\b.*--mode[ =](\S+)/)?.[1] ?? null;
    if (Object.keys(env).length || mode) sets.push({ source: `package.json: ${name}`, env, mode });
  }
  return sets;
}

// One variant per distinct environment; its name is made of the values that differ between them,
// the least varied first ("betbg-pre_prod").
function variantsFromSets(sets) {
  const unique = [];
  const seen = new Set();
  for (const set of sets) {
    const key = JSON.stringify([Object.entries(set.env).sort(), set.mode ?? null]);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(set);
  }
  const names = [...new Set(unique.flatMap(set => Object.keys(set.env)))];
  const distinct = name => new Set(unique.map(set => set.env[name] ?? '')).size;
  const varying = names.filter(name => distinct(name) > 1).sort((a, b) => distinct(a) - distinct(b) || a.localeCompare(b));
  const ids = new Set();
  return unique.map((set, index) => {
    const parts = varying.map(name => set.env[name]).filter(Boolean);
    if (set.mode) parts.push(set.mode);
    let id = (parts.join('-') || `variant-${index + 1}`).toLowerCase().replace(/[^\w.-]+/g, '_');
    while (ids.has(id)) id = `${id}-${index + 1}`;
    ids.add(id);
    return { id, env: set.env, mode: set.mode ?? null, source: set.source };
  });
}

function configPort(text) {
  const port = Number(String(text ?? '').match(/\bport\s*:\s*(\d{4,5})\b/)?.[1]);
  return Number.isInteger(port) && port !== 8098 && port !== 8099 ? port : null;
}

export async function scanWebProject(repo, pkg) {
  const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
  if (dependencies.next) throw new Error('Next.js projects are not supported by perf web yet');
  const viteConfig = ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs', 'vite.config.cjs'].find(file => exists(path.join(repo, file))) ?? null;
  const webpackConfig = ['webpack.config.js', 'webpack.config.cjs', 'webpack.config.mjs', 'webpack.prod.js', 'webpack.config.prod.js'].find(file => exists(path.join(repo, file))) ?? null;
  const bundler = viteConfig || dependencies.vite ? 'vite' : webpackConfig ? 'webpack' : dependencies['react-scripts'] ? 'cra' : null;
  const bundlerConfig = bundler === 'vite' ? viteConfig : bundler === 'webpack' ? webpackConfig : null;
  const { sourceDirs, candidates } = scanSourceDirs(repo, pkg);
  const wanted = referencedEnv(repo, bundlerConfig, sourceDirs);
  // CI jobs set the whole environment of a real build; a package.json script that sets only part of
  // it (no SITE_ID, say) relies on the shell for the rest, so it is kept only without CI data.
  const ciSets = ciEnvSets(repo, wanted);
  const ciKeys = new Set(ciSets.flatMap(set => Object.keys(set.env)));
  const scriptSets = scriptEnvSets(pkg, wanted).filter(set => !ciSets.length || [...ciKeys].every(name => name in set.env));
  const variants = variantsFromSets([...ciSets, ...scriptSets]);
  if (!variants.length) variants.push({ id: normalize(pkg.name) || 'web', env: {}, mode: null, source: null });
  // A non-production variant first: APIs of staging / dev usually allow a local origin.
  const preferred = variants.find(variant => /dev|stag|pre/i.test(variant.id)) ?? variants[0];
  const port = configPort(bundlerConfig && read(path.join(repo, bundlerConfig))) ?? (bundler === 'vite' ? 4173 : bundler === 'cra' ? 3000 : 8080);
  const installed = name => exists(path.join(repo, 'node_modules', name, 'package.json'));
  return {
    repo,
    project: {
      kind: 'web',
      name: pkg.name ?? path.basename(repo),
      bundler,
      bundlerConfig,
      port,
      sourceDirs: [...sourceDirs, ...candidates],
      defaultVariant: preferred.id,
      variants: variants.map(({ id, env, mode }) => ({ id, env, mode }))
    },
    found: {
      variantSources: variants.map(variant => ({ id: variant.id, source: variant.source })),
      envNames: [...wanted].sort(),
      sourceDirCandidates: candidates
    },
    checks: {
      nodeModules: exists(path.join(repo, 'node_modules')),
      git: exists(path.join(repo, '.git')),
      react: dependencies.react ?? null,
      reactDomProfiling: exists(path.join(repo, 'node_modules/react-dom/profiling.js')),
      bundlerInstalled:
        bundler === 'vite' ? installed('vite') : bundler === 'cra' ? installed('react-scripts') && installed('webpack-dev-server') : installed('webpack') && installed('webpack-cli') && installed('webpack-dev-server')
    }
  };
}

export async function scanProject(repo) {
  repo = path.resolve(repo);
  const pkg = JSON.parse(read(path.join(repo, 'package.json')) ?? 'null');
  if (!pkg) throw new Error(`No package.json in ${repo}`);
  const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
  if (!dependencies['react-native']) {
    if (dependencies.react) return scanWebProject(repo, pkg);
    throw new Error(`${repo} is neither a React Native nor a React web project (no react / react-native in package.json)`);
  }

  const [ios, signing] = await Promise.all([scanIos(repo), scanTeams()]);
  const android = scanAndroid(repo);
  const env = scanEnv(repo, pkg);
  const { sourceDirs, candidates } = scanSourceDirs(repo, pkg);
  const entry = ['index.js', 'index.ts', 'index.tsx'].find(file => exists(path.join(repo, file)))?.replace(/\.[jt]sx?$/, '') ?? (pkg.main ? pkg.main.replace(/\.[jt]sx?$/, '') : 'index');
  const metroConfig = ['metro.config.js', 'metro.config.cjs'].find(file => exists(path.join(repo, file))) ?? null;

  const keys = env.variants.length
    ? env.variants.map(item => item.id)
    : android.flavors.length
      ? android.flavors.map(item => item.flavor.toLowerCase())
      : ios.schemes.length > 1
        ? ios.schemes.map(item => normalize(item.scheme))
        : [normalize(pkg.name) || 'app'];
  const iosFor = match(keys, ios.schemes, item => `${item.scheme} ${item.bundleId}`);
  const androidFor = match(keys, android.flavors, item => `${item.flavor} ${item.package}`);
  const splashScripts = dependencies['react-native-bootsplash'] ? Object.keys(pkg.scripts ?? {}).filter(name => /splash/i.test(name) && /ios/i.test(name)) : [];

  const variants = keys.map(id => {
    const scheme = iosFor(id) ?? (ios.schemes.length === 1 ? ios.schemes[0] : null);
    const flavor = androidFor(id);
    const base = id.split(/[.\-_]/)[0];
    return {
      id,
      env: env.variants.find(item => item.id === id)?.file ?? null,
      ios: scheme
        ? {
            workspace: ios.workspace,
            scheme: scheme.scheme,
            bundleId: scheme.bundleId,
            team: teamForBundle(scheme.bundleId, signing.profiles) ?? scheme.team,
            executable: scheme.executable,
            splashScript: keys.length > 1 ? splashScripts.find(name => normalize(name).includes(normalize(base))) ?? null : null
          }
        : null,
      android: flavor ? { flavor: flavor.flavor, package: flavor.package } : android.package && !android.flavors.length ? { flavor: '', package: android.package } : null
    };
  });

  // The variant the env module already is builds with it as it is (as a plain build would); its
  // own env file stays a suggestion on the setup page.
  const defaultVariant = variants.length === 1 ? variants[0].id : closestVariant(repo, env.module, variants);
  if (env.kind === 'module' && defaultVariant) variants.find(variant => variant.id === defaultVariant).env = null;

  return {
    repo,
    project: {
      name: pkg.name ?? path.basename(repo),
      entry,
      metroConfig,
      envKind: env.kind,
      envModule: env.module,
      navigationRef: findNavigationRef(repo, sourceDirs),
      sourceDirs: [...sourceDirs, ...candidates],
      defaultVariant,
      variants
    },
    found: {
      schemes: ios.schemes,
      flavors: android.flavors,
      envFiles: env.variants,
      teams: signing.teams,
      sourceDirCandidates: candidates,
      splashScripts
    },
    checks: {
      nodeModules: exists(path.join(repo, 'node_modules')),
      pods: !exists(path.join(repo, 'ios')) || exists(path.join(repo, 'ios/Pods')),
      git: exists(path.join(repo, '.git')),
      reactNative: dependencies['react-native']
    }
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--repo');
  const repo = index === -1 ? process.cwd() : process.argv[index + 1];
  const [project, tools] = await Promise.all([scanProject(repo), scanTools()]);
  console.log(JSON.stringify({ ...project, tools }, null, 2));
}
