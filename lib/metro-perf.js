/* eslint-disable @typescript-eslint/no-var-requires */
// Wraps a project's own Metro config for live-profiling builds. Used only through the generated
// config that `perf ios|android` passes to the bundler (BUNDLE_CONFIG / Gradle init script),
// so the project itself is never modified.
const path = require('path');

const PROFILING_RENDERERS = /(ReactFabric|ReactNativeRenderer)-prod$/;

function apply(config, { repoRoot, bundleDir, envModule, envFile }) {
  const upstreamResolve = config.resolver.resolveRequest;
  const minifierConfig = config.transformer.minifierConfig || {};

  return {
    ...config,
    projectRoot: config.projectRoot || repoRoot,
    // A pasted env file lives outside the project, so Metro has to watch its folder too.
    watchFolders: [...(config.watchFolders || []), bundleDir, ...(envFile ? [path.dirname(envFile)] : [])],
    resolver: {
      ...config.resolver,
      // The probe lives outside the project; let it resolve react-native from the project.
      nodeModulesPaths: [...(config.resolver.nodeModulesPaths || []), path.join(repoRoot, 'node_modules')],
      // The profiling renderer records per-fiber durations in release builds.
      resolveRequest(context, moduleName, platform) {
        const target = PROFILING_RENDERERS.test(moduleName)
          ? moduleName.replace(/-prod$/, '-profiling')
          : moduleName;
        const resolution = upstreamResolve
          ? upstreamResolve(context, target, platform)
          : context.resolveRequest(context, target, platform);
        // The variant's env file is bundled in place of the project's env module, which is
        // never touched.
        if (envFile && resolution.type === 'sourceFile' && resolution.filePath === envModule) {
          return { type: 'sourceFile', filePath: envFile };
        }
        return resolution;
      }
    },
    transformer: {
      ...config.transformer,
      // Keeps component names readable so renders can be mapped back to source files.
      minifierConfig: {
        ...minifierConfig,
        keep_classnames: true,
        keep_fnames: true,
        mangle: { ...(minifierConfig.mangle || {}), keep_classnames: true, keep_fnames: true }
      }
    }
  };
}

function withPerfProbe(projectConfig, options) {
  if (typeof projectConfig === 'function') {
    return async (...args) => apply(await projectConfig(...args), options);
  }
  if (projectConfig && typeof projectConfig.then === 'function') {
    return projectConfig.then(config => apply(config, options));
  }
  return apply(projectConfig, options);
}

module.exports = { withPerfProbe };
