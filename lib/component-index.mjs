// Maps component names (as React reports them) to the source files that define them.
import fs from 'node:fs';
import path from 'node:path';
import { projectConfig, sourceRootsOf } from './config.mjs';

const SOURCE_FILE = /\.(jsx?|tsx?)$/;
const SKIP_DIR = /^(node_modules|__tests__|__mocks__|testing|\.git)$/;
// `const Name: React.FC<Props> = …` (TypeScript) may carry a type between the name and `=`.
const DEFINITIONS = [
  /(?:^|\n)[ \t]*(?:export\s+(?:default\s+)?)?function\s+([A-Z][A-Za-z0-9_]*)\s*\(/g,
  /(?:^|\n)[ \t]*(?:export\s+)?const\s+([A-Z][A-Za-z0-9_]*)\s*(?::[^=\n]+)?=\s*(?:React\.)?(?:memo|forwardRef)?\(?\s*(?:\([^)]*\)|[A-Za-z_]\w*)\s*=>/g,
  /(?:^|\n)[ \t]*(?:export\s+)?const\s+([A-Z][A-Za-z0-9_]*)\s*(?::[^=\n]+)?=\s*(?:React\.)?(?:memo|forwardRef)\(/g,
  /(?:^|\n)[ \t]*(?:export\s+(?:default\s+)?)?class\s+([A-Z][A-Za-z0-9_]*)\s+extends\s+/g
];

// The source folders saved on the setup page (default: src/).
export function sourceRoots(repoRoot) {
  return sourceRootsOf(repoRoot, projectConfig(repoRoot));
}

export function sourceFiles(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIR.test(entry.name)) sourceFiles(path.join(dir, entry.name), files);
    } else if (SOURCE_FILE.test(entry.name) && !/\.(test|spec)\./.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      files.push(path.join(dir, entry.name));
    }
  }
  return files;
}

// Component definitions with their 1-based line numbers.
export function definitionsIn(source) {
  const found = [];
  for (const pattern of DEFINITIONS) {
    for (const match of source.matchAll(pattern)) {
      const offset = match.index + match[0].indexOf(match[1]);
      found.push({ name: match[1], line: source.slice(0, offset).split('\n').length });
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

export function buildComponentIndex(repoRoot) {
  const index = new Map();
  for (const root of sourceRoots(repoRoot)) {
    for (const file of sourceFiles(root.dir)) {
      const relative = path.join(root.prefix, path.relative(root.dir, file));
      for (const { name } of definitionsIn(fs.readFileSync(file, 'utf8'))) {
        const existing = index.get(name);
        if (!existing) index.set(name, relative);
        else if (!existing.split(' | ').includes(relative)) index.set(name, `${existing} | ${relative}`);
      }
    }
  }
  return index;
}

