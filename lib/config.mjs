// Per-project settings, made by the setup page (or `perf init`) from a scan of the project:
//   ~/.config/perf-tool/projects.json → { projects: { "<absolute project path>": Project } }
//
// Project: {
//   name, entry ("index"), metroConfig ("metro.config.js"), envModule ("env.js" | null),
//   navigationRef ("src/navigator/navigationRef.js" | null), sourceDirs (["src", …]),
//   defaultVariant, variants: [Variant]
// }
// Variant (a brand / domain / white label): {
//   id ("brand-a"), env (file bundled instead of envModule | null = the project's own),
//   ios: { workspace, scheme, bundleId, team, executable, splashScript } | null,
//   android: { flavor ("BrandA" | ""), package } | null
// }
//
// CLI used by `perf`:
//   node config.mjs shell --repo <path> [--variant <id>]   bash assignments for that variant
//   node config.mjs has --repo <path>                       exit 0 when the project is set up
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONFIG_DIR = path.join(os.homedir(), '.config', 'perf-tool');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'projects.json');
// Env files pasted on the setup page: kept outside every project, readable only by this user.
export const ENV_DIR = path.join(CONFIG_DIR, 'env');

export function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return { version: 1, projects: {} };
  }
}

export function projectConfig(repo) {
  return readConfig().projects[path.resolve(repo)] ?? null;
}

export function saveProject(repo, project) {
  const config = readConfig();
  config.projects[path.resolve(repo)] = project;
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`);
}

// Resolved against the project; absolute paths (pasted env files) stay as they are.
export const inProject = (repo, file) => (file ? path.resolve(repo, file) : null);

export function sourceRootsOf(repo, project) {
  const dirs = project?.sourceDirs?.length ? project.sourceDirs : ['src'];
  return dirs
    .map(dir => ({ dir: path.resolve(repo, dir), prefix: dir.replace(/^node_modules\/(@[^/]+\/)?/, '') }))
    .filter(root => fs.existsSync(root.dir));
}

export function pickVariant(project, id) {
  const variants = project.variants ?? [];
  if (!variants.length) throw new Error('No variants configured: open the setup page (perf init)');
  if (id) {
    const variant = variants.find(item => item.id.toLowerCase() === id.toLowerCase());
    if (!variant) throw new Error(`Unknown variant '${id}' (configured: ${variants.map(item => item.id).join(', ')})`);
    return variant;
  }
  return variants.find(item => item.id === project.defaultVariant) ?? variants[0];
}

// What a saved project needs: a way to build each variant.
export function validateProject(project) {
  const errors = [];
  if (!project?.name?.trim()) errors.push('Project name is required');
  if (!project?.variants?.length) errors.push('Add at least one variant');
  const ids = new Set();
  for (const variant of project?.variants ?? []) {
    if (!/^[\w.-]+$/.test(variant.id ?? '')) errors.push(`Variant name '${variant.id ?? ''}' may only use letters, digits, . _ -`);
    if (ids.has(variant.id)) errors.push(`Variant '${variant.id}' is listed twice`);
    ids.add(variant.id);
    if (!variant.ios && !variant.android) errors.push(`Variant '${variant.id}' has neither iOS nor Android settings`);
    if (variant.ios && (!variant.ios.scheme || !variant.ios.bundleId)) errors.push(`Variant '${variant.id}': iOS needs a scheme and a bundle id`);
    if (variant.ios?.team && !/^[A-Z0-9]{10}$/.test(variant.ios.team)) errors.push(`Variant '${variant.id}': Team ID is 10 capital letters/digits (e.g. ABCDE12345)`);
    if (variant.android && !variant.android.package) errors.push(`Variant '${variant.id}': Android needs the application id (package)`);
  }
  if (project?.variants?.length > 1 && !project.variants.some(variant => variant.id === project.defaultVariant)) {
    errors.push('Choose the default variant (used when no --variant is given)');
  }
  return errors;
}

// The commands a configured project offers, for the setup page and `perf init --auto`.
export function commandsFor(project) {
  const many = project.variants.length > 1;
  const flag = variant => (many ? ` --variant ${variant.id}` : '');
  const list = [];
  for (const variant of project.variants) {
    if (variant.ios) {
      list.push({ command: `perf ios${flag(variant)}`, what: `${variant.id}: Release + probe on the iPhone connected by cable, dashboard opens` });
      list.push({ command: `perf ios "<device or simulator>"${flag(variant)}`, what: `${variant.id}: same on a named device or simulator (see perf devices)` });
    }
    if (variant.android) list.push({ command: `perf android${flag(variant)}`, what: `${variant.id}: Android release + probe on the connected device, dashboard opens` });
  }
  const scripts = project.variants.flatMap(variant =>
    ['ios', 'android'].filter(platform => variant[platform]).map(platform => `yarn perf:${platform}${many ? `:${variant.id}` : ''}`)
  );
  return {
    main: list,
    scripts,
    other: [
      { command: 'perf devices', what: 'iOS devices and simulators, Android devices' },
      { command: 'perf server', what: 'only the dashboard (http://localhost:8099), e.g. for an app that is already installed' },
      { command: 'perf compiler', what: 'React Compiler status per component' },
      { command: 'perf init', what: 'this setup page again' },
      { command: 'perf update', what: 'update perf-tool from git' },
      { command: 'perf clean', what: 'remove generated files and probe build caches' },
      { command: 'perf help', what: 'everything else' }
    ]
  };
}

const quote = value => `'${String(value ?? '').replace(/'/g, `'\\''`)}'`;

function shellAssignments(repo, project, variant) {
  const ios = variant.ios ?? {};
  const android = variant.android ?? {};
  const values = {
    PROJECT_NAME: project.name,
    VARIANT: variant.id,
    VARIANTS: project.variants.map(item => item.id).join(' '),
    ENV_FILE: variant.env ? inProject(repo, variant.env) : '',
    ENV_KIND: project.envKind ?? 'module',
    IOS_WORKSPACE: inProject(repo, ios.workspace) ?? '',
    IOS_SCHEME: ios.scheme ?? '',
    IOS_BUNDLE: ios.bundleId ?? '',
    IOS_EXECUTABLE: ios.executable ?? '',
    IOS_SPLASH_SCRIPT: ios.splashScript ?? '',
    CONFIG_TEAM: ios.team ?? '',
    ANDROID_FLAVOR: android.flavor ?? '',
    ANDROID_PACKAGE: android.package ?? ''
  };
  return Object.entries(values).map(([name, value]) => `${name}=${quote(value)}`).join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = name => {
    const index = args.indexOf(`--${name}`);
    return index === -1 ? undefined : args[index + 1];
  };
  const repo = path.resolve(option('repo') ?? process.cwd());
  const project = projectConfig(repo);
  if (args[0] === 'has') process.exit(project ? 0 : 1);
  if (args[0] === 'shell') {
    if (!project) {
      console.error(`perf: ${repo} is not set up yet — run 'perf init' or open the Perf Tool app`);
      process.exit(2);
    }
    try {
      console.log(shellAssignments(repo, project, pickVariant(project, option('variant'))));
    } catch (error) {
      console.error(`perf: ${error.message}`);
      process.exit(2);
    }
  }
}
