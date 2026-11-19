/**
 * Shared state of one CMC module instance: resolved options, the bridge connection, record
 * storage on the credential event, relationship leases and telemetry.
 */
import boiler from 'dev-boiler';
import { cmc, pryv } from 'hds-lib';
import type { StatusClass } from 'hds-observability-js';
import {
  bridgeConnection as libBridgeConnection, getUserParentStreamId, getActiveUserStreamId, isValidCmcUserKey
} from '../lib/bridgeAccount.ts';
import { getCredentialEvent, addCredentialToBridgeAccount } from '../methods/user.ts';
import { cacheLock, cacheRenew, cacheUnlock, cacheDel } from '../lib/cache.ts';
import { bridgeTelemetry, type CmcMethodId, type CmcErrorCode } from '../lib/observability.ts';
import { isSchedulerWorker } from '../lib/schedulerRole.ts';
import type { CmcConnection, CmcHooks, CmcRelationship, CmcRelationshipRecord, CmcRelationshipsOptions } from './types.ts';

const { getConfig, getLogger } = boiler;

export const CREDENTIAL_TYPE = 'credentials/pryv-api-endpoint';

export interface Resolved {
  appCode: string;
  scopeStreamId: string;
  invite: { expiresInSeconds: number; features: { chat?: boolean; systemMessaging?: boolean } };
  inbox: { intervalMs: number; lagS: number; initialCursor: number | null };
  scopePollMs: number;
  reconcileMs: number;
  leaseTtlMs: number;
  webhooks: { enabled: boolean; publicBaseUrl: string | null };
  hostPattern: RegExp | null;
  patientAppBaseUrl: string | null;
  serviceInfoURL: string;
}

export interface Ctx {
  o: Resolved;
  hooks: CmcHooks;
  bridge: () => CmcConnection;
  connectionFor: (apiEndpoint: string) => CmcConnection;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  isScheduler: () => boolean;
  logger: ReturnType<typeof getLogger>;
  /** Last values seen by this worker, for `health()`. */
  seen: { activeRelationships: number | null; cursor: number | null };
  /** The plugin-facing view of a stored relationship (set by `createCmcRelationships`). */
  rel: (entry: Entry) => CmcRelationship;
}

/** A refusal of the module, branchable on `id` (e.g. `scope-request-open`). */
export class CmcRelationshipError extends Error {
  id: string;
  constructor (id: string, message: string) {
    super(`${message} (${id})`);
    this.name = 'CmcRelationshipError';
    this.id = id;
  }
}

/** A stored relationship: the credential's endpoint (never logged) and its record. */
export interface Entry {
  userKey: string;
  apiEndpoint: string;
  record: CmcRelationshipRecord;
}

const DEFAULTS = {
  appCode: 'hds-bridge-reader',
  invite: { expiresInSeconds: 604800, features: { chat: false, systemMessaging: true } },
  inbox: { intervalS: 30, lagS: 120, initialCursor: null },
  scope: { pollIntervalS: 60 },
  reconcile: { intervalS: 900 },
  leaseTtlMs: 60000,
  webhooks: { enabled: false, publicBaseUrl: null }
};

/** Options override config `cmc:`, which overrides the defaults of DESIGN.md §7. */
export async function createContext (options: CmcRelationshipsOptions): Promise<Ctx> {
  if (typeof options?.hooks?.onRevoked !== 'function') throw new Error('createCmcRelationships: hooks.onRevoked is required');
  const config = await getConfig();
  const c = (key: string): any => config.get(key);
  const pick = <T>(opt: T | undefined, key: string, def: T): T => opt !== undefined ? opt : (c(key) ?? def);
  const appCode = pick(options.appCode, 'cmc:appCode', DEFAULTS.appCode);
  const pattern = pick<string | null>(options.apiEndpointHostPattern, 'service:apiEndpointHostPattern', null);
  const o: Resolved = {
    appCode,
    scopeStreamId: cmc.appScope(appCode),
    invite: {
      expiresInSeconds: pick(options.invite?.expiresInSeconds, 'cmc:invite:expiresInSeconds', DEFAULTS.invite.expiresInSeconds),
      features: pick(options.invite?.features, 'cmc:invite:features', DEFAULTS.invite.features)
    },
    inbox: {
      intervalMs: 1000 * pick(options.inbox?.intervalS, 'cmc:inbox:intervalS', DEFAULTS.inbox.intervalS),
      lagS: pick(options.inbox?.lagS, 'cmc:inbox:lagS', DEFAULTS.inbox.lagS),
      initialCursor: pick<number | null>(options.inbox?.initialCursor, 'cmc:inbox:initialCursor', DEFAULTS.inbox.initialCursor)
    },
    scopePollMs: 1000 * pick(options.scope?.pollIntervalS, 'cmc:scope:pollIntervalS', DEFAULTS.scope.pollIntervalS),
    reconcileMs: 1000 * pick(options.reconcile?.intervalS, 'cmc:reconcile:intervalS', DEFAULTS.reconcile.intervalS),
    leaseTtlMs: pick(options.leaseTtlMs, 'cmc:leaseTtlMs', DEFAULTS.leaseTtlMs),
    webhooks: {
      enabled: pick(options.webhooks?.enabled, 'cmc:webhooks:enabled', DEFAULTS.webhooks.enabled) === true,
      publicBaseUrl: pick<string | null>(options.webhooks?.publicBaseUrl, 'cmc:webhooks:publicBaseUrl', DEFAULTS.webhooks.publicBaseUrl)
    },
    // Anchored at the end, so `\.datasafe\.dev` cannot match `datasafe.dev.evil.com` (mira's rule).
    hostPattern: pattern == null || pattern === '' ? null : new RegExp(pattern.endsWith('$') ? pattern : `${pattern}$`),
    patientAppBaseUrl: pick<string | null>(options.patientAppBaseUrl, 'service:patientAppBaseUrl', null),
    serviceInfoURL: String(c('service:serviceInfoURL') ?? '')
  };
  if (o.webhooks.enabled && (o.webhooks.publicBaseUrl == null || o.webhooks.publicBaseUrl === '')) {
    throw new Error('cmc:webhooks:enabled needs cmc:webhooks:publicBaseUrl');
  }
  return {
    o,
    hooks: options.hooks,
    bridge: () => (options.bridgeConnection ?? libBridgeConnection)() as CmcConnection,
    connectionFor: options.connectionFor ?? ((apiEndpoint: string) => new pryv.Connection(apiEndpoint) as unknown as CmcConnection),
    now: options.now ?? (() => Date.now()),
    sleep: options.sleep ?? ((ms: number) => new Promise(resolve => { setTimeout(resolve, ms).unref(); })),
    isScheduler: options.isScheduler ?? (() => isSchedulerWorker()),
    logger: getLogger('cmc'),
    seen: { activeRelationships: null, cursor: null },
    rel: () => { throw new Error('cmc: context not wired'); }
  };
}

export function nowS (ctx: Ctx): number {
  return ctx.now() / 1000;
}

/** Fail closed: no pattern, no accepted host. */
export function hostAllowed (ctx: Ctx, apiEndpoint: string): boolean {
  if (ctx.o.hostPattern == null) return false;
  try {
    return ctx.o.hostPattern.test(new URL(apiEndpoint).hostname);
  } catch {
    return false;
  }
}

export function record (method: CmcMethodId, statusClass: StatusClass, startedAt: number, ctx: Ctx): void {
  bridgeTelemetry.recordCall(method, statusClass, ctx.now() - startedAt);
}

export function recordError (code: CmcErrorCode): void {
  bridgeTelemetry.recordError(code);
}

export function errorMessage (e: unknown): string {
  return (e as Error)?.message ?? String(e);
}

function asRecord (clientData: Record<string, unknown> | undefined): CmcRelationshipRecord | null {
  const r = clientData?.hdsCmc as CmcRelationshipRecord | undefined;
  return r != null && r.v === 1 && typeof r.generation === 'string' ? r : null;
}

/** The stored relationship of `userKey`, or null (none, or a credential without a CMC record). */
export async function getEntry (userKey: string): Promise<Entry | null> {
  if (!isValidCmcUserKey(userKey)) return null;
  const cred = await getCredentialEvent(userKey);
  const rec = asRecord(cred?.clientData);
  if (cred == null || rec == null) return null;
  return { userKey, apiEndpoint: cred.apiEndpoint, record: rec };
}

/** Store the credential (re-tagged active) with its record. */
export async function saveEntry (entry: Entry): Promise<void> {
  await addCredentialToBridgeAccount(entry.userKey, entry.apiEndpoint, { clientData: { hdsCmc: entry.record } });
}

/** Every stored relationship, from the credential events under `{main}-users`. */
export async function listEntries (ctx: Ctx): Promise<Entry[]> {
  const parent = getUserParentStreamId();
  const active = getActiveUserStreamId();
  const res = await ctx.bridge().api([{
    method: 'events.get', params: { streams: [parent], types: [CREDENTIAL_TYPE], limit: 10000 }
  }]);
  if (res?.[0]?.error != null) throw new Error(`cmc: listing relationships failed: ${res[0].error.id}`);
  const out = new Map<string, Entry>();
  for (const e of res?.[0]?.events ?? []) {
    const rec = asRecord(e.clientData);
    const stream = (e.streamIds as string[] ?? []).find(s => s.startsWith(parent + '-') && s !== active);
    if (rec == null || stream == null) continue;
    const userKey = stream.slice(parent.length + 1);
    // newest first: keep the first one per user, as `getCredentialEvent` does
    if (!out.has(userKey)) out.set(userKey, { userKey, apiEndpoint: e.content, record: rec });
  }
  ctx.seen.activeRelationships = out.size;
  return [...out.values()];
}

export const leaseKey = (userKey: string): string => `cmc:rel:${userKey}`;
export const againKey = (userKey: string): string => `cmc:again:${userKey}`;
export const hookKey = (hookId: string): string => `cmc:hook:${hookId}`;

export async function forgetHook (hookId: string): Promise<void> {
  await cacheDel(hookKey(hookId));
}

/**
 * Run `fn` holding the relationship lease, renewed while it runs. Waits up to `waitMs` for a busy
 * lease; returns `{ busy: true }` when it could not be taken. An expired holder can never release
 * its successor's lease (owner token).
 */
export async function withLease<T> (
  ctx: Ctx, userKey: string, fn: () => Promise<T>, waitMs = 0
): Promise<{ busy: true } | { busy: false, value: T }> {
  const key = leaseKey(userKey);
  const ttl = ctx.o.leaseTtlMs;
  const until = ctx.now() + waitMs;
  let token = await cacheLock(key, ttl);
  while (token == null && ctx.now() < until) {
    await ctx.sleep(100);
    token = await cacheLock(key, ttl);
  }
  if (token == null) return { busy: true };
  const held = token;
  const renew = setInterval(() => {
    cacheRenew(key, held, ttl).then(ok => {
      if (!ok) ctx.logger.warn(`cmc: lease of ${userKey} lost while held`);
    }).catch(() => {});
  }, Math.max(1000, Math.floor(ttl / 3)));
  renew.unref();
  try {
    return { busy: false, value: await fn() };
  } finally {
    clearInterval(renew);
    await cacheUnlock(key, held).catch(() => false);
  }
}
