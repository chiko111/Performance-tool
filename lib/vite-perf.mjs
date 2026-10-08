// Wraps a Vite project's own config for `perf web` (vite build + vite preview). Used only through the
// generated config in .generated/<project>/, so the project is never modified. Same goals as
// lib/webpack-perf.cjs: the probe first in <head>, React DOM's profiling build, readable component
// names, source maps, a build folder of perf-tool's own, /__perf proxied to the dashboard server and
// a size summary (perf-stats.json).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

function profilingAlias(repoRoot, log) {
  const require = createRequire(path.join(repoRoot, 'package.json'));
  let profiling;
  let major = null;
  try {
    profiling = require.resolve('react-dom/profiling');
    major = Number(require('react/package.json').version.split('.')[0]);
  } catch {
    log('perf: react-dom/profiling not found: render times will be missing');
    return [];
  }
  // React 19: react-dom/client is the renderer; earlier: react-dom itself.
  return major >= 19
    ? [{ find: /^react-dom\/client$/, replacement: profiling }]
    : [{ find: /^react-dom$/, replacement: profiling }];
}

function aliasList(alias) {
  if (!alias) return [];
  if (Array.isArray(alias)) return alias;
  return Object.entries(alias).map(([find, replacement]) => ({ find, replacement }));
}

function statsPlugin(statsFile, repoRoot) {
  return {
    name: 'perf-stats',
    apply: 'build',
    generateBundle(_options, bundle) {
      const chunks = [];
      const assets = [];
      for (const [file, output] of Object.entries(bundle)) {
        const bytes = output.type === 'chunk' ? Buffer.byteLength(output.code) : Buffer.byteLength(output.source ?? '');
        assets.push({ file, bytes });
        if (output.type !== 'chunk') continue;
        chunks.push({
          name: output.name,
          initial: output.isEntry || false,
          files: [{ file, bytes }, ...[...(output.viteMetadata?.importedCss ?? [])].map(css => ({ file: css, bytes: 0 }))],
          modules: Object.entries(output.modules).map(([id, info]) => ({ id, bytes: info.renderedLength }))
        });
      }
      const size = new Map(assets.map(asset => [asset.file, asset.bytes]));
      for (const chunk of chunks) for (const item of chunk.files) item.bytes = size.get(item.file) ?? item.bytes;
      fs.mkdirSync(path.dirname(statsFile), { recursive: true });
      fs.writeFileSync(statsFile, JSON.stringify({ version: 2, bundler: 'vite', context: repoRoot, chunks, assets }));
    }
  };
}

const probePlugin = {
  name: 'perf-probe',
  transformIndexHtml: {
    order: 'pre',
    handler: html => ({ html, tags: [{ tag: 'script', attrs: { src: '/__perf/probe.js' }, injectTo: 'head-prepend' }] })
  }
};

async function resolveUserConfig(userConfig, env) {
  const value = typeof userConfig === 'function' ? await userConfig(env) : await userConfig;
  return value ?? {};
}

export function withPerfProbe(userConfig, { repoRoot, outDir, statsFile, port, perfPort, log = console.log }) {
  return async env => {
    const config = await resolveUserConfig(userConfig, { ...env, mode: env.mode ?? 'production' });
    const perfProxy = {
      '/__perf': { target: `http://127.0.0.1:${perfPort}`, xfwd: true, rewrite: url => url.replace(/^\/__perf/, '') }
    };
    const terserOptions = config.build?.terserOptions ?? {};
    return {
      ...config,
      resolve: { ...(config.resolve ?? {}), alias: [...profilingAlias(repoRoot, log), ...aliasList(config.resolve?.alias)] },
      // esbuild (Vite's default minifier) and terser both keep function and class names.
      esbuild: config.esbuild === false ? false : { ...(config.esbuild ?? {}), keepNames: true },
      build: {
        ...(config.build ?? {}),
        outDir,
        emptyOutDir: true,
        sourcemap: true,
        terserOptions: { ...terserOptions, keep_fnames: true, keep_classnames: true, mangle: terserOptions.mangle === false ? false : { ...(terserOptions.mangle ?? {}), keep_fnames: true, keep_classnames: true } }
      },
      plugins: [...(config.plugins ?? []), probePlugin, statsPlugin(statsFile, repoRoot)],
      preview: {
        ...(config.preview ?? {}),
        host: true,
        port,
        strictPort: true,
        open: false,
        proxy: { ...perfProxy, ...(config.preview?.proxy ?? config.server?.proxy ?? {}) }
      }
    };
  };
}
