import boiler from 'dev-boiler';
import type { Config, Logger } from 'dev-boiler';
import type { Application } from 'express';
import * as errors from '../errors/index.ts';
import * as user from '../methods/user.ts';
import { logSyncStatus } from './bridgeAccount.ts';
import { cacheGet, cacheSet, cacheDel } from './cache.ts';

const { getLogger: _getLogger, getConfig } = boiler;

export const getLogger = _getLogger;

/**
 * Utility to be extended by all plugins.
 * The main task is to centralize internals so the structure of
 * lib-bridge-js can be modified without affecting plugins.
 */
export default class PluginBridge {
  /**
   * Logger, you can call .info(..) .error(...) and .debug(..)
   */
  logger: Logger;

  /**
   * set of errors, most usefull are
   * assertFromPartner, unkownRessource, unauthorized, badRequest, internalError
   */
  errors: typeof errors;

  /**
   * returns the data items this plugin is going to create
   * From this permissions will be adjusted
   */
  get potentialCreatedItemKeys (): string[] {
    return [];
  }

  /**
   * private instance of config
   */
  #config: Config | null = null;

  /**
   * private instance of bridgeConnectionGetter (form lib/bridgeAccount)
   */
  #bridgeConnectionGetter: (() => unknown) | null = null;

  constructor () {
    this.logger = _getLogger('plugin:' + this.key);
    this.errors = errors;
  }

  /**
   * a key unique for your plugin
   */
  get key (): string {
    throw new Error('Must be implemented');
  }

  /**
   * connection to bridge managing account
   */
  get bridgeConnection (): unknown {
    return this.#bridgeConnectionGetter!();
  }

  /**
   * Must be exposed, called once at boot.
   * Use this to declare your routes.
   */
  async init (app: Application, bridgeConnectionGetter: () => unknown): Promise<void> {
    if (!app) throw new Error('Missing "app" param');
    if (!bridgeConnectionGetter) throw new Error('Missing "bridgeConnectionGetter" param');
    this.#config = await getConfig();
    this.#bridgeConnectionGetter = bridgeConnectionGetter;
    // perform async initaliazion tasks here
    // load your routes
    // when overriden call init.super()
  }

  /**
   * Called each time a new user user is associated.
   * You may use this to create base streams for you app
   */
  async newUserAssociated (partnerUserId: string, apiEndPoint: string): Promise<unknown> {
    throw new Error('Must be implemented');
    // returns something
  }

  // --------- toolkit ------------- //

  /**
   * Retreive configuration item
   */
  configGet (key: string): any {
    return this.#config!.get(key);
  }

  /**
   * Throws Unothorized if call is not comming from partner
   */
  assertFromPartner (req: unknown): void {
    errors.assertFromPartner(req as any);
  }

  /**
   * From a partenerUserId get a pryvConnection and user status
   */
  async getPryvUserConnectionAndStatus (partnerUserId: string): Promise<any> {
    return user.getPryvConnectionAndStatus(partnerUserId);
  }

  /**
   * Log a successfull synchronization
   */
  async logSyncStatus (partnerUserId: string, time: number | null, content: unknown): Promise<unknown> {
    return logSyncStatus(partnerUserId, time, content);
  }

  // --------- shared cache ------------- //

  /**
   * Store a value in the shared cluster cache.
   * Shared across all workers in cluster mode.
   */
  async cacheSet (key: string, value: unknown, ttlMs?: number): Promise<void> {
    return cacheSet(key, value, ttlMs);
  }

  /**
   * Get a value from the shared cluster cache.
   */
  async cacheGet<T = unknown> (key: string): Promise<T | undefined> {
    return cacheGet<T>(key);
  }

  /**
   * Delete a value from the shared cluster cache.
   */
  async cacheDel (key: string): Promise<void> {
    return cacheDel(key);
  }
}
