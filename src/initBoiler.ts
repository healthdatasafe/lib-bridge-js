/**
 * To be called first for any app launch.
 * consumerConfigDir: path to the consumer's config/ directory (with default-config.yml).
 * If not provided, uses lib-bridge-js's own config/ directory.
 */
import path from 'path';
import { createRequire } from 'module';
import type { Boiler, Config, ExtraConfig } from 'dev-boiler';

const require = createRequire(import.meta.url);

const bridgeConfigDir = path.resolve(import.meta.dirname, '../config');

export default function initBoiler (appName: string, consumerConfigDir?: string): Boiler {
  const extraConfigs: ExtraConfig[] = [];
  if (process.env.NODE_ENV === 'test') {
    const testConfig = path.resolve(consumerConfigDir || bridgeConfigDir, 'test-config.yml');
    extraConfigs.push({ scope: 'test-config', file: testConfig });
  }
  extraConfigs.push({
    pluginAsync: {
      load: async function (store: Config): Promise<string> {
        const storageDir = store.get<string>('storage:files:directory') || './storage';
        const baseDir = consumerConfigDir ? path.resolve(consumerConfigDir, '..') : path.resolve(import.meta.dirname, '..');
        const storageDirAbsolute = path.resolve(baseDir, storageDir);
        store.set('storage:files:directoryAbsolute', storageDirAbsolute);
        return 'plugin-fileDirectoryAbsolute'; // my name
      }
    }
  });
  // Use consumer's config dir if provided, with lib-bridge-js defaults as fallback
  const configDir = consumerConfigDir || bridgeConfigDir;
  const baseFilesDir = consumerConfigDir ? path.resolve(consumerConfigDir, '..') : path.resolve(import.meta.dirname, '..');
  const boiler = require('dev-boiler').init({
    appName,
    baseFilesDir,
    baseConfigDir: configDir,
    extraConfigs
  }) as Boiler;
  return boiler;
}

// load debug $$ in test mode
if (process.env.NODE_ENV === 'test') {
  (async () => {
    await import('./lib/debug.ts');
  })();
}
