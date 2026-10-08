// Heavy images, fonts and videos shipped with the app (source folders, public/ for web, build output from stats).
import fs from 'node:fs';
import path from 'node:path';
import { kb, makeFinding, sortFindings, walkFiles } from './common.mjs';

const MB = 1024 * 1024;
// Share previews and icons for the OS/browser chrome: fetched by crawlers and launchers, not by the page.
const NOT_LOADED_BY_PAGE = /(^|\/)(og|opengraph|social)(\/|[-_.])|(^|\/)(favicon|apple-touch-icon|android-chrome|mstile|maskable)[^/]*$/i;
const RULES = [
  { test: /\.(png|jpe?g)$/i, limit: 150, what: 'image', fix: kind => (kind === 'web' ? 'Convert to WebP/AVIF and resize it to the largest size it is displayed at.' : 'Resize it to the largest size it is displayed at and compress it (WebP works on iOS and Android).') },
  { test: /\.gif$/i, limit: 300, what: 'GIF', fix: () => 'Replace it with a muted looping video (MP4/WebM) or an animated WebP – typically 5-10× smaller.' },
  { test: /\.svg$/i, limit: 40, what: 'SVG', fix: () => 'Run it through SVGO; if it embeds a bitmap, ship that bitmap as WebP instead.' },
  { test: /\.(webp|avif)$/i, limit: 300, what: 'image', fix: () => 'Resize it to the size it is displayed at and lower the quality setting.' },
  { test: /\.(ttf|otf|woff2?|eot)$/i, limit: 150, what: 'font', fix: kind => (kind === 'web' ? 'Ship WOFF2 only and subset it to the scripts/glyphs you use.' : 'Subset the font to the scripts/glyphs you use.') },
  { test: /\.(mp4|webm|mov|m4v)$/i, limit: 1024, what: 'video', fix: () => 'Compress it (H.264/H.265, lower bitrate) or stream it instead of bundling it.' }
];

function check(file, bytes, label, ctx, findings) {
  const rule = RULES.find(item => item.test.test(file));
  if (!rule || bytes / 1024 <= rule.limit) return;
  const size = kb(bytes);
  let extra = '';
  if (/\.svg$/i.test(file) && bytes < 5 * MB) {
    try {
      if (/data:image\/(png|jpe?g|webp)/.test(fs.readFileSync(file, 'utf8'))) extra = ' It embeds a base64 bitmap.';
    } catch {}
  }
  findings.push({
    rule: 'heavy-asset',
    severity: bytes > MB ? 'high' : bytes / 1024 > rule.limit * 2 ? 'medium' : 'low',
    file: label,
    bytes,
    what: rule.what,
    message: `${size} kB ${rule.what} (limit ${rule.limit} kB): it is downloaded${ctx.kind === 'web' ? '' : ' with the app'} and decoded on the device, costing load time and memory.${extra}`,
    fix: rule.fix(ctx.kind),
    key: label
  });
}

const RANK = { high: 3, medium: 2, low: 1 };

// A folder with many heavy files (a set of sport icons) is one thing to fix: one finding with the total and the
// largest ones. Files over 1 MB stay on their own.
function groupByFolder(items) {
  const byDir = new Map();
  for (const item of items) {
    const dir = path.dirname(item.file);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(item);
  }
  const result = [];
  for (const [dir, list] of byDir) {
    const single = list.filter(item => item.bytes > MB);
    const rest = list.filter(item => item.bytes <= MB);
    result.push(...single);
    if (rest.length < 5) {
      result.push(...rest);
      continue;
    }
    rest.sort((a, b) => b.bytes - a.bytes);
    const total = rest.reduce((sum, item) => sum + item.bytes, 0);
    const kinds = [...new Set(rest.map(item => item.what))].join(' / ');
    result.push({
      rule: 'heavy-asset',
      severity: rest.reduce((best, item) => (RANK[item.severity] > RANK[best] ? item.severity : best), 'low'),
      file: dir,
      message: `${rest.length} ${kinds} files over their limit in this folder, ${kb(total)} kB together; largest: ${rest.slice(0, 5).map(item => `${path.basename(item.file)} ${kb(item.bytes)} kB`).join(', ')}. Each is downloaded and decoded on the device.`,
      fix: rest[0].fix,
      key: `folder:${dir}`
    });
  }
  return result;
}

// webpack names build files "name-[contenthash].ext": the same file as one in the sources is reported once.
const withoutHash = file => path.basename(file).replace(/[-.][0-9a-f]{8,}(?=\.[^.]+$)/i, '');

// Folders listed in react-native.config.js `assets: ['./assets/fonts']` are bundled into the app too.
function nativeAssetDirs(repoRoot) {
  try {
    const text = fs.readFileSync(path.join(repoRoot, 'react-native.config.js'), 'utf8');
    const list = text.match(/assets\s*:\s*\[([^\]]*)\]/);
    return [...(list?.[1].matchAll(/(['"])([^'"]+)\1/g) ?? [])].map(match => path.resolve(repoRoot, match[2]));
  } catch {
    return [];
  }
}

export function runAssets(ctx) {
  const findings = [];
  const dirs = ctx.roots.map(root => ({ dir: root.dir, prefix: root.prefix }));
  const extra = ctx.kind === 'web' ? [path.join(ctx.repoRoot, 'public')] : nativeAssetDirs(ctx.repoRoot);
  for (const dir of extra) {
    if (fs.existsSync(dir) && !dirs.some(item => dir.startsWith(item.dir))) dirs.push({ dir, prefix: path.relative(ctx.repoRoot, dir) });
  }
  const seen = new Set();
  const sourceAssets = new Set(); // "name.ext|bytes" of every asset in the sources
  for (const { dir, prefix } of dirs) {
    for (const file of walkFiles(dir, name => RULES.some(rule => rule.test.test(name)), /^(node_modules|\.git)$/)) {
      if (seen.has(file) || NOT_LOADED_BY_PAGE.test(path.relative(ctx.repoRoot, file))) continue;
      seen.add(file);
      const bytes = fs.statSync(file).size;
      sourceAssets.add(`${path.basename(file)}|${bytes}`);
      check(file, bytes, path.join(prefix, path.relative(dir, file)), ctx, findings);
    }
  }
  // Build output (hashed file names) from the stats file: what users actually download, when it is not already
  // reported from the sources (node_modules assets, generated files).
  for (const asset of ctx.stats?.assets ?? []) {
    if (!asset?.file || !asset.bytes || sourceAssets.has(`${withoutHash(asset.file)}|${asset.bytes}`)) continue;
    check(asset.file, asset.bytes, `build: ${asset.file}`, ctx, findings);
  }
  return { findings: sortFindings(groupByFolder(findings).map(item => makeFinding({ ...item, bytes: undefined, what: undefined }))) };
}
