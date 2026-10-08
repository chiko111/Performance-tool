// perf init: opens the setup page for the project (the server stops with Ctrl-C).
// perf init --auto: scans and saves without asking, when the scan alone gives complete settings
// (used by the first `perf ios|android` in a new project). Every variant the scan finds is saved,
// so --variant works right away; perf init changes or removes them.
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanProject } from './scan.mjs';
import { saveProject, validateProject, commandsFor, CONFIG_FILE } from './config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const index = args.indexOf('--repo');
const repo = path.resolve(index === -1 ? process.cwd() : args[index + 1]);

if (args.includes('--auto')) {
  const { project } = await scanProject(repo);
  const errors = validateProject(project);
  if (errors.length) {
    console.error(`The scan could not fill in everything:\n${errors.map(error => `  - ${error}`).join('\n')}`);
    process.exit(1);
  }
  saveProject(repo, project);
  console.log(`Saved to ${CONFIG_FILE}:`);
  for (const variant of project.variants) {
    if (project.kind === 'web') {
      const env = Object.entries(variant.env ?? {}).map(([name, value]) => `${name}=${value}`).join(' ');
      console.log(`  ${variant.id}${variant.id === project.defaultVariant ? ' (default)' : ''}: ${project.bundler}${env ? ` · ${env}` : ''}${variant.mode ? ` · mode ${variant.mode}` : ''}`);
      continue;
    }
    const parts = [
      variant.env && `env ${variant.env}`,
      variant.ios && `iOS ${variant.ios.scheme} (${variant.ios.bundleId}${variant.ios.team ? `, team ${variant.ios.team}` : ''})`,
      variant.android && `Android ${variant.android.flavor || 'release'} (${variant.android.package})`
    ].filter(Boolean);
    console.log(`  ${variant.id}${variant.id === project.defaultVariant ? ' (default)' : ''}: ${parts.join(' · ')}`);
  }
  console.log(`Commands: ${commandsFor(project).main.map(item => item.command).filter(command => !command.includes('<')).join(' | ')}`);
} else {
  const server = spawn(process.execPath, [path.join(here, 'setup-server.mjs'), '--repo', repo], { stdio: 'inherit' });
  setTimeout(() => execFile('open', ['http://localhost:8098']), 600);
  process.on('SIGINT', () => server.kill('SIGINT'));
  server.on('close', code => process.exit(code === 3 ? 0 : code ?? 0));
}
