import boiler from 'dev-boiler';
import { initHDSModel, getHDSModel } from 'hds-lib';
import { bridgeConnection } from './bridgeAccount.ts';
import type PluginBridge from './PluginBridge.ts';
import type { Application } from 'express';

const { getLogger } = boiler;
let _logger: ReturnType<typeof getLogger> | null = null;
function logger () { return _logger || (_logger = getLogger('plugins')); }

let plugins: PluginBridge[] = [];

/**
 * Initialize plugin(s) with the Express app.
 * @param app - Express application
 * @param plugin - Single plugin instance or array of plugins
 */
async function initWithExpressApp (app: Application, plugin?: PluginBridge | PluginBridge[]): Promise<void> {
  await initHDSModel();
  if (plugin) {
    plugins = Array.isArray(plugin) ? plugin : [plugin];
  }
  for (const p of plugins) {
    await p.init(app, bridgeConnection);
    logger().info(`Loaded plugin: ${p.key}`);
  }
}

/**
 * Get plugin required permissions
 */
function requiredPermissionsAndStreams (existingPermissions: unknown[] = []): { permissions: any[]; streams: any[] } {
  const itemKeys = new Set<string>();
  for (const plugin of plugins) {
    plugin.potentialCreatedItemKeys.forEach(itemKey => itemKeys.add(itemKey));
  }
  const itemKeysArray = [...itemKeys];
  const streams = getHDSModel().streams.getNecessaryListForItems(itemKeysArray);
  const permissions = getHDSModel().authorizations.forItemKeys(itemKeysArray, { defaultLevel: 'manage', preRequest: existingPermissions as any });
  return { permissions, streams };
}

/**
 * Announce new User to plugins
 */
async function advertiseNewUserToPlugins (partnerUserId: string, apiEndpoint: string): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const plugin of plugins) {
    try {
      const pluginResult = await plugin.newUserAssociated(partnerUserId, apiEndpoint);
      result[plugin.key] = pluginResult;
    } catch (e: any) {
      logger().error(e);
      result[plugin.key] = { error: e.message };
    }
  }
  return result;
}

export { initWithExpressApp, advertiseNewUserToPlugins, requiredPermissionsAndStreams };
