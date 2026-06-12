import boiler from '@pryv/boiler';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import express from 'express';
import type { Application } from 'express';
import cors from 'cors';

import { init as pryvServiceInit } from './lib/pryvService.ts';
import { init as bridgeAccountInit } from './lib/bridgeAccount.ts';
import { init as onboardInit } from './methods/onboard.ts';
import * as checkAuth from './middlewares/checkAuth.ts';
import * as plugins from './lib/plugins.ts';
import accountRouter from './routes/accountRoute.ts';
import userRouter from './routes/userRoute.ts';
import { expressErrorHandler } from './errors/index.ts';
import loggerMiddleware from './middlewares/logger.ts';
import type PluginBridge from './lib/PluginBridge.ts';

const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf-8'));

const { getLogger, getConfig } = boiler;
let _logger: ReturnType<typeof getLogger> | null = null;
function logger () { return _logger || (_logger = getLogger('server')); }

const require = createRequire(import.meta.url);

// list (in order) async methods to be called.
const initAsyncComponents = [
  pryvServiceInit,
  bridgeAccountInit,
  checkAuth.init
];

let app: Application | null = null;

/**
 * Create a configured Express app with the given plugin.
 * App is a singleton — subsequent calls return the same instance.
 */
async function createBridgeApp (plugin?: PluginBridge): Promise<Application> {
  if (app != null) return app;
  // initalize singletons & configs
  for (const init of initAsyncComponents) {
    await init();
  }

  const newApp = express();

  newApp.use(cors());
  newApp.use(express.json());

  // keep first
  newApp.use(loggerMiddleware);
  newApp.use(checkAuth.checkIfPartner);

  newApp.get('/status', (_req, res) => {
    res.json({ status: 'ok', name: pkg.name, version: pkg.version, uptime: Math.floor(process.uptime()) });
  });

  // static ressource are temporary until handled by externall apps.
  newApp.use('/static', express.static(path.resolve(import.meta.dirname, 'static')));
  newApp.use('/account', accountRouter);
  newApp.use('/user', userRouter);

  // init plugin, then onboard (needs plugin permissions)
  await plugins.initWithExpressApp(newApp, plugin);
  await onboardInit();

  // ------------ must be last ------- //
  newApp.use(expressErrorHandler);
  app = newApp;
  return app;
}

/* c8 ignore start - Cannot be tested with supertest */
/**
 * Launch a server instance with the given plugin.
 */
async function launch (plugin?: PluginBridge): Promise<Application> {
  const currentApp = await createBridgeApp(plugin);
  const config = await getConfig();
  const configServer = config.get<{ port?: number; host?: string }>('server');
  const port = configServer.port || 7432;
  if (process.env.BACKLOOP) {
    const https = await import('https');
    const { httpsOptionsPromise } = require('backloop.dev');
    const httpsOptions = await httpsOptionsPromise();
    https.createServer(httpsOptions, currentApp).listen(port);
    config.set('baseURL', 'https://mira.backloop.dev:' + port);
  } else {
    const host = configServer.host || '127.0.0.1';
    await new Promise<void>((resolve) => { currentApp.listen(port, host, resolve); });
    logger().info(`Listening ${host} on port ${port} in mode ${currentApp.get('env')}`);
  }
  return currentApp;
}
/* c8 ignore stop */

// Legacy alias
const getApp = createBridgeApp;

export { launch, createBridgeApp, getApp };
