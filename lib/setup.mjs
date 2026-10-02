// Adds (or with --remove, removes) the perf scripts to the project's package.json, one per
// platform of each variant saved on the setup page:
//   one domain:      yarn perf:ios ["<device>"]           yarn perf:android [serial]
//   multi-domain:    yarn perf:ios:<variant> ["<device>"] yarn perf:android:<variant> [serial]
// The scripts only call the installed `perf` command; the tool itself stays outside the project.
import fs from 'node:fs';
import path from 'node:path';
import { projectConfig } from './config.mjs';

const args = process.argv.slice(2);
const repoIndex = args.indexOf('--repo');
const repoRoot = path.resolve(repoIndex === -1 ? process.cwd() : args[repoIndex + 1]);
const remove = args.includes('--remove');
const quiet = args.includes('--quiet');
const log = message => quiet || console.log(message);
const packageFile = path.join(repoRoot, 'package.json');

const NOT_INSTALLED =
  "command -v perf >/dev/null || { echo 'perf-tool is not installed: open the Perf Tool app (or run ~/perf-tool/install.sh)'; exit 1; }";
const variants = projectConfig(repoRoot)?.variants ?? [];
const many = variants.length > 1;
const SCRIPTS = Object.fromEntries(
  variants.flatMap(variant =>
    ['ios', 'android']
      .filter(platform => variant[platform])
      .map(platform => [
        `perf:${platform}${many ? `:${variant.id}` : ''}`,
        `${NOT_INSTALLED}; perf ${platform}${many ? ` --variant ${variant.id}` : ''}`
      ])
  )
);
// Ours: every perf:ios / perf:android script that calls the perf command (also of variants
// removed since), so --remove leaves nothing behind.
const isOurs = (name, command) => /^perf:(ios|android)(:|$)/.test(name) && String(command).includes('command -v perf');

const source = fs.readFileSync(packageFile, 'utf8');
const indent = source.match(/^[ \t]+(?=")/m)?.[0] ?? '  ';
const trailingNewline = source.endsWith('\n') ? '\n' : '';
const pkg = JSON.parse(source);
const scripts = { ...(pkg.scripts ?? {}) };

for (const [name, command] of Object.entries(scripts)) {
  if (isOurs(name, command) && (remove || !(name in SCRIPTS))) delete scripts[name];
}
if (!remove) Object.assign(scripts, SCRIPTS);

const next = JSON.stringify({ ...pkg, scripts }, null, indent) + trailingNewline;
if (next === source) {
  log(remove ? 'No perf scripts in package.json.' : 'package.json already has the perf scripts.');
} else {
  fs.writeFileSync(packageFile, next);
  log(
    remove
      ? `Removed the perf scripts from ${packageFile}`
      : `Added to ${packageFile}:\n${Object.keys(SCRIPTS)
          .map(name => `  yarn ${name}`)
          .join('\n')}\n(iOS: pass the device name, or leave it out to use the one connected iPhone.)`
  );
}
