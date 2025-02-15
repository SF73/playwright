/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import fs from 'fs';
import type http from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import { assert, calculateSha1, getPlaywrightVersion, isURLAvailable } from 'playwright-core/lib/utils';
import { debug } from 'playwright-core/lib/utilsBundle';
import { internalDependenciesForTestFile, setExternalDependencies } from 'playwright/lib/transform/compilationCache';
import { stoppable } from 'playwright/lib/utilsBundle';
import type { FullConfig } from 'playwright/test';
import type { Suite } from 'playwright/types/testReporter';
import type { PluginContext } from 'rollup';
import type { Plugin, ResolveFn, ResolvedConfig } from 'vite';
import type { TestRunnerPlugin } from '../../playwright/src/plugins';
import { source as injectedSource } from './generated/indexSource';
import type { ImportInfo } from './tsxTransform';
import type { ComponentRegistry } from './viteUtils';
import { createConfig, hasJSComponents, populateComponentsFromTests, resolveDirs, resolveEndpoint, transformIndexFile } from './viteUtils';
import { resolveHook } from 'playwright/lib/transform/transform';

const log = debug('pw:vite');

let stoppableServer: any;
const playwrightVersion = getPlaywrightVersion();

export function createPlugin(
  registerSourceFile: string,
  frameworkPluginFactory?: () => Promise<Plugin>): TestRunnerPlugin {
  let configDir: string;
  let config: FullConfig;
  return {
    name: 'playwright-vite-plugin',

    setup: async (configObject: FullConfig, configDirectory: string) => {
      config = configObject;
      configDir = configDirectory;
    },

    begin: async (suite: Suite) => {
      {
        // Detect a running dev server and use it if available.
        const endpoint = resolveEndpoint(config);
        const protocol = endpoint.https ? 'https:' : 'http:';
        const url = new URL(`${protocol}//${endpoint.host}:${endpoint.port}`);
        if (await isURLAvailable(url, true)) {
          // eslint-disable-next-line no-console
          console.log(`Test Server is already running at ${url.toString()}, using it.\n`);
          process.env.PLAYWRIGHT_TEST_BASE_URL = url.toString();
          return;
        }
      }

      const dirs = await resolveDirs(configDir, config);
      const buildInfoFile = path.join(dirs.outDir, 'metainfo.json');

      let buildExists = false;
      let buildInfo: BuildInfo;

      const registerSource = injectedSource + '\n' + await fs.promises.readFile(registerSourceFile, 'utf-8');
      const registerSourceHash = calculateSha1(registerSource);

      const { version: viteVersion, build, preview, mergeConfig } = await import('vite');

      try {
        buildInfo = JSON.parse(await fs.promises.readFile(buildInfoFile, 'utf-8')) as BuildInfo;
        assert(buildInfo.version === playwrightVersion);
        assert(buildInfo.viteVersion === viteVersion);
        assert(buildInfo.registerSourceHash === registerSourceHash);
        buildExists = true;
      } catch (e) {
        buildInfo = {
          version: playwrightVersion,
          viteVersion,
          registerSourceHash,
          components: [],
          sources: {},
          deps: {},
        };
      }
      log('build exists:', buildExists);

      const componentRegistry: ComponentRegistry = new Map();
      const componentsByImportingFile = new Map<string, string[]>();
      // 1. Populate component registry based on tests' component imports.
      await populateComponentsFromTests(componentRegistry, componentsByImportingFile);

      // 2. Check if the set of required components has changed.
      const hasNewComponents = await checkNewComponents(buildInfo, componentRegistry);
      log('has new components:', hasNewComponents);

      // 3. Check component sources.
      const sourcesDirty = !buildExists || hasNewComponents || await checkSources(buildInfo);
      log('sourcesDirty:', sourcesDirty);

      // 4. Update component info.
      buildInfo.components = [...componentRegistry.values()];

      const jsxInJS = hasJSComponents(buildInfo.components);
      const viteConfig = await createConfig(dirs, config, frameworkPluginFactory, jsxInJS);

      if (sourcesDirty) {
        // Only add out own plugin when we actually build / transform.
        log('build');
        const depsCollector = new Map<string, string[]>();
        const buildConfig = mergeConfig(viteConfig, {
          plugins: [vitePlugin(registerSource, dirs.templateDir, buildInfo, componentRegistry, depsCollector)]
        });
        await build(buildConfig);
        buildInfo.deps = Object.fromEntries(depsCollector.entries());

        // Update dependencies based on the vite build.
        for (const projectSuite of suite.suites) {
          for (const fileSuite of projectSuite.suites) {
            // For every test file...
            const testFile = fileSuite.location!.file;
            const deps = new Set<string>();
            // Collect its JS dependencies (helpers).
            for (const file of [testFile, ...(internalDependenciesForTestFile(testFile) || [])]) {
              // For each helper, get all the imported components.
              for (const componentFile of componentsByImportingFile.get(file) || []) {
                // For each component, get all the dependencies.
                for (const d of depsCollector.get(componentFile) || [])
                  deps.add(d);
              }
            }
            // Now we have test file => all components along with dependencies.
            setExternalDependencies(testFile, [...deps]);
          }
        }
      }

      if (hasNewComponents || sourcesDirty) {
        log('write manifest');
        await fs.promises.writeFile(buildInfoFile, JSON.stringify(buildInfo, undefined, 2));
      }

      const previewServer = await preview(viteConfig);
      stoppableServer = stoppable(previewServer.httpServer as http.Server, 0);
      const isAddressInfo = (x: any): x is AddressInfo => x?.address;
      const address = previewServer.httpServer.address();
      if (isAddressInfo(address)) {
        const protocol = viteConfig.preview.https ? 'https:' : 'http:';
        process.env.PLAYWRIGHT_TEST_BASE_URL = `${protocol}//${viteConfig.preview.host}:${address.port}`;
      }
    },

    end: async () => {
      if (stoppableServer)
        await new Promise(f => stoppableServer.stop(f));
    },
  };
}

type BuildInfo = {
  version: string,
  viteVersion: string,
  registerSourceHash: string,
  sources: {
    [key: string]: {
      timestamp: number;
    }
  };
  components: ImportInfo[];
  deps: {
    [key: string]: string[];
  }
};

async function checkSources(buildInfo: BuildInfo): Promise<boolean> {
  for (const [source, sourceInfo] of Object.entries(buildInfo.sources)) {
    try {
      const timestamp = (await fs.promises.stat(source)).mtimeMs;
      if (sourceInfo.timestamp !== timestamp) {
        log('source has changed:', source);
        return true;
      }
    } catch (e) {
      log('check source failed:', e);
      return true;
    }
  }
  return false;
}

async function checkNewComponents(buildInfo: BuildInfo, componentRegistry: ComponentRegistry): Promise<boolean> {
  const newComponents = [...componentRegistry.keys()];
  const oldComponents = new Map(buildInfo.components.map(c => [c.id, c]));

  let hasNewComponents = false;
  for (const c of newComponents) {
    if (!oldComponents.has(c)) {
      hasNewComponents = true;
      break;
    }
  }
  for (const c of oldComponents.values())
    componentRegistry.set(c.id, c);

  return hasNewComponents;
}

function vitePlugin(registerSource: string, templateDir: string, buildInfo: BuildInfo, importInfos: Map<string, ImportInfo>, depsCollector: Map<string, string[]>): Plugin {
  buildInfo.sources = {};
  let moduleResolver: ResolveFn;
  return {
    name: 'playwright:component-index',

    configResolved(config: ResolvedConfig) {
      moduleResolver = config.createResolver();
    },

    async transform(this: PluginContext, content, id) {
      const queryIndex = id.indexOf('?');
      const file = queryIndex !== -1 ? id.substring(0, queryIndex) : id;
      if (!buildInfo.sources[file]) {
        try {
          const timestamp = (await fs.promises.stat(file)).mtimeMs;
          buildInfo.sources[file] = { timestamp };
        } catch {
          // Silent if can't read the file.
        }
      }
      return transformIndexFile(id, content, templateDir, registerSource, importInfos);
    },

    async writeBundle(this: PluginContext) {
      for (const importInfo of importInfos.values()) {
        const importPath = resolveHook(importInfo.filename, importInfo.importSource);
        if (!importPath)
          continue;
        const deps = new Set<string>();
        const id = await moduleResolver(importPath);
        if (!id)
          continue;
        collectViteModuleDependencies(this, id, deps);
        depsCollector.set(importPath, [...deps]);
      }
    },
  };
}

function collectViteModuleDependencies(context: PluginContext, id: string, deps: Set<string>) {
  if (!path.isAbsolute(id))
    return;
  const normalizedId = path.normalize(id);
  if (deps.has(normalizedId))
    return;
  deps.add(normalizedId);
  const module = context.getModuleInfo(id);
  for (const importedId of module?.importedIds || [])
    collectViteModuleDependencies(context, importedId, deps);
  for (const importedId of module?.dynamicallyImportedIds || [])
    collectViteModuleDependencies(context, importedId, deps);
}
