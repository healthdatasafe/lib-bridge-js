import initBoiler from '../../src/initBoiler.ts';
import { initCacheLocal } from '../../src/lib/cache.ts';
import request from 'supertest';
import ShortUniqueId from 'short-unique-id';
import { getApp } from '../../src/server.ts';
import * as pryvService from '../../src/lib/pryvService.ts';
import { pryv, initHDSModel } from 'hds-lib';
import * as user from '../../src/methods/user.ts';
import { requiredPermissionsAndStreams } from '../../src/lib/plugins.ts';
import type { Application } from 'express';
import type { Config } from 'dev-boiler';
import type PluginBridge from '../../src/lib/PluginBridge.ts';
import SampleBridge from '../sample-bridge/index.ts';

let app: Application | null = null;
let config: Config | null = null;

/**
 * Initalize the server, to be run once before the tests.
 * @param plugin - plugin instance (defaults to sample-plugin for lib-bridge-js tests)
 * @param configDir - optional config directory (for consumer repos)
 */
async function init (plugin?: PluginBridge, configDir?: string): Promise<void> {
  initCacheLocal();
  const { getConfig } = initBoiler(`bridge:${process.pid}`, configDir);
  await initHDSModel();
  config = await getConfig();
  app = await getApp(plugin || new SampleBridge());
  await pryvService.init();
}

/**
 * Whether a real bridge account is configured. The integration tests below
 * onboard users against the bridge account identified by `bridgeApiEndPoint`
 * — a live Pryv apiEndpoint that only exists in a developer's gitignored
 * `localConfig.yml`, never in the repo (it embeds an auth token). Without it,
 * `pryvService.init()` throws `Cannot find endpoint, invalid URL format`.
 *
 * Call from a `before` hook as `if (!(await bridgeIsConfigured())) this.skip()`
 * so those tests SKIP with a clear reason instead of hard-failing — the suite
 * stays meaningful (unit tests gate; integration tests light up only when a
 * dev has provisioned an account). `npm run setup-dev-env` + `config/sample-localConfig.yml`.
 */
async function bridgeIsConfigured (): Promise<boolean> {
  const { getConfig } = initBoiler(`bridge-cfg-check:${process.pid}`);
  const cfg = await getConfig();
  const ep = cfg.get<string>('bridgeApiEndPoint');
  return typeof ep === 'string' && /^https?:\/\//.test(ep) && !ep.includes('OVERRIDE_ME');
}

/**
 * Get a supertest Request bound to the server app
 */
function apiTest (options?: Record<string, unknown>) {
  if (app === null) throw new Error('Call testServer.init() first');
  return request(app, options);
}

/**
 * Return partner auth Header
 */
function partnerAuth (key?: string) {
  return { authorization: config!.get<string>('partnerAuthToken') };
}

/**
 * Shortcut for (await getConfig()).get()
 */
function configGet<T = any> (key: string): T {
  return config!.get<T>(key);
}

/**
 * Create userAccountAndPermission
 */
async function createUserAndPermissions (
  username: string,
  permissions: Array<Record<string, unknown>>,
  appId: string = 'bridge-test-suite',
  password?: string | null,
  email?: string | null,
  streams: Array<Record<string, unknown>> = []
) {
  password = password || 'pass_' + username;
  email = email || username + '@hds.bogus';
  const newUser = await pryvService.createuser(username, password, email);
  const personalConnection = new pryv.Connection(newUser.apiEndpoint);
  // -- create streams
  const apiCallStreamCreate = streams.map(s => ({ method: 'streams.create', params: s }));
  await personalConnection.api(apiCallStreamCreate as any);

  // -- create access
  const accessRequest = {
    method: 'accesses.create',
    params: {
      type: 'app',
      name: appId,
      permissions
    }
  };
  const res: any = await personalConnection.api([accessRequest] as any);
  const appApiEndpoint = res[0]?.access?.apiEndpoint;

  const result = {
    username,
    personalApiEndpoint: newUser.apiEndpoint,
    appId,
    appApiEndpoint
  };

  return result;
}

/**
 * Create an onBoardeduser
 */
async function createOnboardedUser () {
  const partnerUserId = (new ShortUniqueId({ dictionary: 'alphanum_lower', length: 18 })).rnd();
  const username = (new ShortUniqueId({ dictionary: 'alphanum_lower', length: 8 })).rnd();
  const { permissions, streams } = requiredPermissionsAndStreams(configGet('service:userPermissionRequest') as unknown[]);
  const appId = configGet<string>('service:appId');
  const result = await createUserAndPermissions(username, permissions, appId, null, null, streams);
  await user.addCredentialToBridgeAccount(partnerUserId, result.appApiEndpoint);
  (result as Record<string, unknown>).partnerUserId = partnerUserId;
  return result as typeof result & { partnerUserId: string };
}

export {
  init,
  bridgeIsConfigured,
  apiTest,
  configGet,
  pryvService,
  createUserAndPermissions,
  createOnboardedUser,
  partnerAuth,
  getApp
};
