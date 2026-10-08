/* eslint-disable @typescript-eslint/no-var-requires */
// Wraps a web project's own webpack config for `perf web`. Used only through the generated config in
// .generated/<project>/, so the project itself is never modified. The result is a production build
// (served by webpack-dev-server with the project's own devServer settings) that:
//   - loads the probe first (<script src="/__perf/probe.js"> at the top of <head>);
//   - uses React DOM's profiling build, which reports per-component render times;
//   - keeps function and class names through minification, so components keep their names;
//   - writes source maps (stack traces and long-animation-frame scripts map back to source files);
//   - builds into perf-tool's cache with its own webpack cache, never into the project's build folder;
//   - proxies /__perf to the perf dashboard server, so phones on the network reach it too;
//   - reports progress and a size summary (perf-stats.json) for the Code health tab.
const fs = require('fs');
const path = require('path');

const PROBE_TAG = '<script src="/__perf/probe.js"></script>';

function requireFrom(repoRoot, request) {
  return require(require.resolve(request, { paths: [repoRoot] }));
}

function reactMajor(repoRoot) {
  try {
    return Number(requireFrom(repoRoot, 'react/package.json').version.split('.')[0]);
  } catch {
    return null;
  }
}

// React 19: react-dom/client is the renderer and react-dom/profiling replaces it (it imports the
// shared react-dom index itself, which must stay). React 17/18: react-dom is the renderer.
function profilingAliases(repoRoot) {
  const major = reactMajor(repoRoot);
  let profiling;
  try {
    profiling = require.resolve('react-dom/profiling', { paths: [repoRoot] });
  } catch {
    return { aliases: [], note: 'react-dom/profiling not found: render times will be missing' };
  }
  if (major >= 19) return { aliases: [{ name: 'react-dom/client', alias: profiling }], note: null };
  const aliases = [{ name: 'react-dom', alias: profiling }];
  if (major === 17) {
    try {
      aliases.push({ name: 'scheduler/tracing', alias: require.resolve('scheduler/tracing-profiling', { paths: [repoRoot] }) });
    } catch {
      // scheduler without tracing (React 18+ packages)
    }
  }
  return { aliases, note: null };
}

// Exact-match aliases ($) in both shapes webpack accepts; the project's own aliases stay.
function withAliases(resolve = {}, aliases) {
  if (!aliases.length) return resolve;
  const current = resolve.alias;
  if (Array.isArray(current)) {
    return { ...resolve, alias: [...aliases.map(item => ({ name: item.name, alias: item.alias, onlyModule: true })), ...current] };
  }
  const exact = Object.fromEntries(aliases.map(item => [`${item.name}$`, item.alias]));
  return { ...resolve, alias: { ...exact, ...(current || {}) } };
}

function keepNames(options = {}) {
  const mangle = options.mangle === false ? false : { ...(typeof options.mangle === 'object' ? options.mangle : {}), keep_fnames: true, keep_classnames: true };
  return { ...options, keep_fnames: true, keep_classnames: true, mangle };
}

// The project's minimizers keep working; Terser (theirs or webpack's default) keeps names.
function minimizers(optimization = {}, repoRoot, log) {
  const list = optimization.minimizer;
  const hasDefault = !list || list.includes('...');
  const result = (list || []).filter(item => item !== '...');
  let terserFound = false;
  for (const plugin of result) {
    const name = plugin && plugin.constructor && plugin.constructor.name;
    if (name === 'TerserPlugin' && plugin.options && plugin.options.minimizer) {
      plugin.options.minimizer.options = keepNames(plugin.options.minimizer.options);
      terserFound = true;
    } else if (name && /esbuild/i.test(name) && plugin.options) {
      plugin.options.keepNames = true;
      terserFound = true;
    }
  }
  if (hasDefault && !terserFound) {
    try {
      const webpackDir = path.dirname(require.resolve('webpack/package.json', { paths: [repoRoot] }));
      const TerserPlugin = require(require.resolve('terser-webpack-plugin', { paths: [webpackDir, repoRoot] }));
      result.unshift(new TerserPlugin({ terserOptions: keepNames({}) }));
    } catch {
      log('perf: terser-webpack-plugin not found; component names may be minified');
    }
  } else if (!terserFound && result.length) {
    log('perf: the project minifies JS with a plugin perf-tool does not know; component names may be minified');
  }
  return result;
}

// webpack-dev-server 4 takes the proxy as an object or an array, 5 only as an array.
function proxyList(proxy) {
  if (!proxy) return [];
  if (Array.isArray(proxy)) return proxy;
  return Object.entries(proxy).map(([context, value]) => (typeof value === 'string' ? { context: [context], target: value } : { context: [context], ...value }));
}

function isSentry(plugin) {
  const names = [plugin && plugin.constructor && plugin.constructor.name, plugin && plugin.name, plugin && plugin._name];
  return names.some(name => typeof name === 'string' && /sentry/i.test(name));
}

class PerfProbePlugin {
  constructor(options) {
    this.options = options;
  }

  apply(compiler) {
    const { statsFile, htmlInjection } = this.options;
    const webpack = compiler.webpack;

    // Progress lines for lib/build-progress.mjs (platform web).
    let lastPercent = -1;
    new webpack.ProgressPlugin((fraction, message) => {
      const percent = Math.floor(fraction * 100);
      if (percent === lastPercent) return;
      lastPercent = percent;
      process.stdout.write(`[perf-progress] ${percent} ${String(message || '').slice(0, 80)}\n`);
    }).apply(compiler);

    if (htmlInjection) {
      compiler.hooks.compilation.tap('PerfProbePlugin', compilation => {
        for (const HtmlPlugin of htmlInjection) {
          HtmlPlugin.getHooks(compilation).beforeEmit.tapAsync('PerfProbePlugin', (data, callback) => {
            data.html = injectProbeTag(data.html);
            callback(null, data);
          });
        }
      });
    }

    compiler.hooks.done.tap('PerfProbePlugin', stats => {
      try {
        fs.mkdirSync(path.dirname(statsFile), { recursive: true });
        fs.writeFileSync(statsFile, JSON.stringify(normalizeStats(stats, compiler.context)));
      } catch (error) {
        process.stdout.write(`perf: could not write ${statsFile}: ${error.message}\n`);
      }
      process.stdout.write(stats.hasErrors() ? '[perf-progress] failed\n' : '[perf-progress] done\n');
    });
  }
}

function injectProbeTag(html) {
  if (html.includes('/__perf/probe.js')) return html;
  const head = html.match(/<head[^>]*>/i);
  if (head) return html.replace(head[0], `${head[0]}\n    ${PROBE_TAG}`);
  return `${PROBE_TAG}\n${html}`;
}

// Chunks with their files and module sizes, in the shape lib/code-health.mjs reads (perf-stats.json). Read from
// the compilation itself: stats.toJson hides "dependent" and grouped modules however it is asked.
function normalizeStats(stats, context) {
  const compilation = stats.compilation;
  const assetSize = new Map();
  for (const asset of compilation.getAssets()) assetSize.set(asset.name, asset.info.size ?? asset.source.size());
  const moduleRows = chunk => {
    const rows = [];
    for (const module of compilation.chunkGraph.getChunkModulesIterable(chunk)) {
      const inner = module.modules; // a concatenated module: its parts
      const parts = inner && inner.length ? inner : [module];
      for (const part of parts) {
        const resource = part.resource || (typeof part.nameForCondition === 'function' && part.nameForCondition()) || part.identifier();
        let bytes = 0;
        try {
          bytes = part.size();
        } catch {
          bytes = 0;
        }
        rows.push({ id: path.relative(context, String(resource).split('!').pop()) || String(resource), bytes });
      }
    }
    return rows;
  };
  return {
    // 2: every module of every chunk (1.13.0 wrote truncated lists).
    version: 2,
    bundler: 'webpack',
    context,
    chunks: [...compilation.chunks].map(chunk => ({
      name: chunk.name || String(chunk.id),
      initial: chunk.canBeInitial(),
      files: [...chunk.files].map(file => ({ file, bytes: assetSize.get(file) || 0 })),
      modules: moduleRows(chunk)
    })),
    assets: [...assetSize].map(([file, bytes]) => ({ file, bytes }))
  };
}

function apply(config, options) {
  const { repoRoot, outDir, cacheDir, cacheName, statsFile, probeFile, port, perfPort, configFiles, log = console.log } = options;
  const { aliases, note } = profilingAliases(repoRoot);
  if (note) log(`perf: ${note}`);

  const plugins = (config.plugins || []).filter(plugin => {
    if (isSentry(plugin)) {
      log('perf: the Sentry plugin is left out of the probe build (no release or source map upload)');
      return false;
    }
    return true;
  });
  const htmlPlugins = plugins.filter(plugin => plugin && plugin.constructor && typeof plugin.constructor.getHooks === 'function' && /Html/.test(plugin.constructor.name));
  const htmlInjection = htmlPlugins.length ? [...new Set(htmlPlugins.map(plugin => plugin.constructor))] : null;
  // Without an HTML plugin the page is the project's own static file: the probe goes first in the entry.
  const entry = htmlInjection ? config.entry : prependEntry(config.entry, probeFile);
  if (!htmlInjection) log('perf: no HtmlWebpackPlugin found; the probe is the first module of the entry instead');

  const devServer = config.devServer || {};
  const ownCache = config.cache && typeof config.cache === 'object' ? config.cache : {};
  return {
    ...config,
    mode: 'production',
    entry,
    devtool: 'source-map',
    output: { ...(config.output || {}), path: outDir },
    resolve: withAliases(config.resolve, aliases),
    // Scope hoisting renames a component that clashes with another module's name to "Module_Component",
    // which no longer matches the sources; without it every component keeps its own name.
    optimization: { ...(config.optimization || {}), concatenateModules: false, minimizer: minimizers(config.optimization, repoRoot, log) },
    // A separate persistent cache: the probe build resolves react-dom differently and must never
    // share cache entries with the project's normal builds. One per variant: env-dependent config
    // (aliases, defines) is not part of webpack's cache validation.
    cache: {
      type: 'filesystem',
      cacheDirectory: cacheDir,
      name: cacheName || 'perf-probe',
      buildDependencies: { ...(ownCache.buildDependencies || {}), perf: configFiles }
    },
    plugins: [...plugins, new PerfProbePlugin({ statsFile, htmlInjection })],
    devServer: {
      ...devServer,
      host: '0.0.0.0',
      port: port || devServer.port || 8080,
      allowedHosts: 'all',
      hot: false,
      liveReload: false,
      client: false,
      webSocketServer: false,
      open: false,
      historyApiFallback: devServer.historyApiFallback === undefined ? true : devServer.historyApiFallback,
      proxy: [
        // xfwd: the dashboard tells phones apart by their address.
        { context: ['/__perf'], target: `http://127.0.0.1:${perfPort}`, pathRewrite: { '^/__perf': '' }, xfwd: true },
        ...proxyList(devServer.proxy)
      ]
    }
  };
}

function prependEntry(entry, file) {
  if (!entry) return [file, './src'];
  if (typeof entry === 'string') return [file, entry];
  if (Array.isArray(entry)) return [file, ...entry];
  if (typeof entry === 'function') return async (...args) => prependEntry(await entry(...args), file);
  return Object.fromEntries(
    Object.entries(entry).map(([name, value]) => {
      if (typeof value === 'string' || Array.isArray(value)) return [name, prependEntry(value, file)];
      if (value && typeof value === 'object' && value.import) return [name, { ...value, import: prependEntry(value.import, file) }];
      return [name, value];
    })
  );
}

// The project's config can be an object, an array, a function (env, argv) or a promise.
function withPerfProbe(projectConfig, options) {
  const wrap = config => (Array.isArray(config) ? config.map(item => apply(item, options)) : apply(config, options));
  if (typeof projectConfig === 'function') {
    return async (env, argv) => wrap(await projectConfig(env, { ...argv, mode: 'production' }));
  }
  if (projectConfig && typeof projectConfig.then === 'function') return projectConfig.then(wrap);
  return wrap(projectConfig);
}

// Create React App: its webpack config comes from react-scripts; dev server settings mirror its own.
function craConfig(repoRoot, { port }) {
  process.env.NODE_ENV = 'production';
  process.env.BABEL_ENV = 'production';
  const factory = requireFrom(repoRoot, 'react-scripts/config/webpack.config.js');
  const config = factory('production');
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const proxy = typeof pkg.proxy === 'string' ? pkg.proxy : null;
  config.devServer = {
    port,
    historyApiFallback: { disableDotRule: true, index: '/' },
    static: { directory: path.join(repoRoot, 'public'), publicPath: '/' },
    // Like CRA's own dev server: requests that are not for a page or a static file go to "proxy".
    proxy: proxy
      ? [{ context: (pathname, request) => !pathname.startsWith('/__perf') && !pathname.startsWith('/static/') && !String(request.headers.accept || '').includes('text/html'), target: proxy, changeOrigin: true }]
      : undefined
  };
  return config;
}

module.exports = { withPerfProbe, craConfig, injectProbeTag };
