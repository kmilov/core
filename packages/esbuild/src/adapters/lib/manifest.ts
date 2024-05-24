import fs from 'fs';
import path from 'path';
import { resolve } from './collect-exports.js';
import {
  BuildOptions,
  PluginBuild,
  Plugin,
  OnResolveArgs,
  OnLoadArgs,
  BuildResult,
  BuildContext,
} from 'esbuild';
//@ts-ignore
import { version as pluginVersion } from '@module-federation/esbuild/package.json';

interface OutputFile {
  entryPoint?: string;
  imports?: { path: string }[];
  exports?: string[];
  kind?: string;
  chunk: string;
}

interface Assets {
  js: { async: string[]; sync: string[] };
  css: { async: string[]; sync: string[] };
}

interface SharedConfig {
  id: string;
  name: string;
  version: string;
  singleton: boolean;
  requiredVersion: string;
  assets: Assets;
}

interface RemoteConfig {
  federationContainerName: string;
  moduleName: string;
  alias: string;
  entry: string;
}

interface ExposeConfig {
  id: string;
  name: string;
  assets: Assets;
  path: string;
}

interface TypesConfig {
  path: string;
  name: string;
  zip: string;
  api: string;
}

interface Manifest {
  id: string;
  name: string;
  metaData: {
    name: string;
    type: string;
    buildInfo: {
      buildVersion: string;
      buildName: string;
    };
    remoteEntry: {
      name: string;
      path: string;
      type: string;
    };
    types: TypesConfig;
    globalName: string;
    pluginVersion: string;
    publicPath: string;
  };
  shared: SharedConfig[];
  remotes: RemoteConfig[];
  exposes: ExposeConfig[];
}

export const writeRemoteManifest = async (config: any, result: BuildResult) => {
  if (result.errors && result.errors.length > 0) {
    console.warn('Build errors detected, skipping writeRemoteManifest.');
    return;
  }

  let packageJson: { name: string };
  try {
    const packageJsonPath =
      (await resolve(process.cwd(), '/package.json')) || '';
    packageJson = require(packageJsonPath);
  } catch (e) {
    packageJson = { name: config.name };
  }
  const mfConfig = config;
  const envType =
    process.env['NODE_ENV'] === 'development'
      ? 'local'
      : process.env['NODE_ENV'] ?? '';
  const publicPath = config.publicPath || 'auto';
  let containerName: string = '';

  const outputMap: Record<string, OutputFile> = Object.entries(
    result.metafile?.outputs || {},
  ).reduce(
    (acc, [chunkKey, chunkValue]) => {
      //@ts-ignore
      const { entryPoint, kind = 'static-import' } = chunkValue;
      const key = entryPoint || chunkKey;
      if (key.startsWith('container:') && key.endsWith(mfConfig.filename)) {
        containerName = key;
      }
      acc[key] = { ...chunkValue, kind, chunk: chunkKey };
      return acc;
    },
    {} as Record<string, OutputFile>,
  );

  if (!outputMap[containerName]) return;

  const outputMapWithoutExt: Record<string, OutputFile> = Object.entries(
    result.metafile?.outputs || {},
  ).reduce(
    (acc, [chunkKey, chunkValue]) => {
      const { entryPoint } = chunkValue;
      const key = entryPoint || chunkKey;
      const trimKey = key.substring(0, key.lastIndexOf('.')) || key;
      acc[trimKey] = { ...chunkValue, chunk: chunkKey };
      return acc;
    },
    {} as Record<string, OutputFile>,
  );

  const getChunks = (
    meta: OutputFile | undefined,
    outputMap: Record<string, OutputFile>,
  ): Assets => {
    const assets: Assets = {
      js: { async: [], sync: [] },
      css: { async: [], sync: [] },
    };

    if (meta?.imports) {
      meta.imports.forEach((imp) => {
        const importMeta = outputMap[imp.path];
        if (importMeta && importMeta.kind !== 'dynamic-import') {
          const childAssets = getChunks(importMeta, outputMap);
          assets.js.async.push(...childAssets.js.async);
          assets.js.sync.push(...childAssets.js.sync);
          assets.css.async.push(...childAssets.css.async);
          assets.css.sync.push(...childAssets.css.sync);
        }
      });

      const assetType = meta.chunk.endsWith('.js') ? 'js' : 'css';
      const syncOrAsync = meta.kind === 'dynamic-import' ? 'async' : 'sync';
      assets[assetType][syncOrAsync].push(meta.chunk);
    }
    return assets;
  };

  const shared: SharedConfig[] = mfConfig.shared
    ? await Promise.all(
        Object.entries(mfConfig.shared).map(
          async ([pkg, config]: [string, any]) => {
            const meta = outputMap['esm-shares:' + pkg];
            const chunks = getChunks(meta, outputMap);
            let { version } = config;

            if (!version) {
              try {
                const packageJsonPath = await resolve(
                  process.cwd(),
                  `${pkg}/package.json`,
                );
                if (packageJsonPath) {
                  version = JSON.parse(
                    fs.readFileSync(packageJsonPath, 'utf-8'),
                  ).version;
                }
              } catch (e) {
                console.warn(
                  `Can't resolve ${pkg} version automatically, consider setting "version" manually`,
                );
              }
            }

            return {
              id: `${mfConfig.name}:${pkg}`,
              name: pkg,
              version: version || config.version,
              singleton: config.singleton || false,
              requiredVersion: config.requiredVersion || '*',
              assets: chunks,
            };
          },
        ),
      )
    : [];

  const remotes: RemoteConfig[] = mfConfig.remotes
    ? Object.entries(mfConfig.remotes).map(([alias, remote]: [string, any]) => {
        const [federationContainerName, entry] = remote.includes('@')
          ? remote.split('@')
          : [alias, remote];

        return {
          federationContainerName,
          moduleName: '',
          alias,
          entry,
        };
      })
    : [];

  const exposes: ExposeConfig[] = mfConfig.exposes
    ? await Promise.all(
        Object.entries(mfConfig.exposes).map(
          async ([expose, value]: [string, any]) => {
            const exposedFound = outputMapWithoutExt[value.replace('./', '')];
            const chunks = getChunks(exposedFound, outputMap);

            return {
              id: `${mfConfig.name}:${expose.replace(/^\.\//, '')}`,
              name: expose.replace(/^\.\//, ''),
              assets: chunks,
              path: expose,
            };
          },
        ),
      )
    : [];

  const types: TypesConfig = {
    path: '',
    name: '',
    zip: '@mf-types.zip',
    api: '@mf-types.d.ts',
  };

  const manifest: Manifest = {
    id: mfConfig.name,
    name: mfConfig.name,
    metaData: {
      name: mfConfig.name,
      type: 'app',
      buildInfo: {
        buildVersion: envType,
        buildName: (packageJson.name ?? 'default').replace(
          /[^a-zA-Z0-9]/g,
          '_',
        ),
      },
      remoteEntry: {
        name: mfConfig.filename,
        path: outputMap[containerName]
          ? path.dirname(outputMap[containerName].chunk)
          : '',
        type: 'esm',
      },
      types,
      globalName: mfConfig.name,
      pluginVersion,
      publicPath,
    },
    shared,
    remotes,
    exposes,
  };

  const manifestPath = path.join(
    path.dirname(outputMap[containerName].chunk),
    'mf-manifest.json',
  );
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
};
