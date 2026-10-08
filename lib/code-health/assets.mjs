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
  findings.push(
    makeFinding({
      rule: 'heavy-asset',
      severity: bytes > MB ? 'high' : bytes / 1024 > rule.limit * 2 ? 'medium' : 'low',
      file: label,
      message: `${size} kB ${rule.what} (limit ${rule.limit} kB): it is downloaded${ctx.kind === 'web' ? '' : ' with the app'} and decoded on the device, costing load time and memory.${extra}`,
      fix: rule.fix(ctx.kind),
      key: label
    })
  );
}

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
  for (const { dir, prefix } of dirs) {
    for (const file of walkFiles(dir, name => RULES.some(rule => rule.test.test(name)), /^(node_modules|\.git)$/)) {
      if (seen.has(file) || NOT_LOADED_BY_PAGE.test(path.relative(ctx.repoRoot, file))) continue;
      seen.add(file);
      check(file, fs.statSync(file).size, path.join(prefix, path.relative(dir, file)), ctx, findings);
    }
  }
  // Build output (hashed file names) from the stats file: what users actually download.
  for (const asset of ctx.stats?.assets ?? []) {
    if (asset?.file && asset.bytes) check(asset.file, asset.bytes, `build: ${asset.file}`, ctx, findings);
  }
  return { findings: sortFindings(findings) };
}
