// lib-bridge-js public API
export { default as PluginBridge } from './lib/PluginBridge.ts';
export { createBridgeApp, launch } from './server.ts';
export { default as startCluster } from './start.ts';
export { default as initBoiler } from './initBoiler.ts';
export * as errors from './errors/index.ts';

// Re-export essentials for consumers
export { initHDSModel, getHDSModel, pryv } from 'hds-lib';
export { default as Router } from 'express-promise-router';
export { default as ShortUniqueId } from 'short-unique-id';

// Utilities needed by consumers (testing, setup)
export { requiredPermissionsAndStreams } from './lib/plugins.ts';
export { init as initPryvService, createuser as createPryvUser } from './lib/pryvService.ts';
export { addCredentialToBridgeAccount } from './methods/user.ts';

// Logger (re-exported from @pryv/boiler to avoid duplicate singleton issues)
export { getLogger } from './lib/PluginBridge.ts';

// Shared cache (cluster-safe via memored)
export { cacheGet, cacheSet, cacheDel, initCacheLocal } from './lib/cache.ts';

// App-streams helper (Plan 25 / Plan 45 Phase 9)
export { ensureAppStreamsTree } from './lib/appStreams.ts';
export type {
  AppStreamSubstream,
  EnsureAppStreamsOptions,
  EnsureAppStreamsResult
} from './lib/appStreams.ts';

// Test helpers — available via 'lib-bridge-js/test' (separate entry to avoid loading test deps in production)
// import * as testServer from 'lib-bridge-js/test';
