/**
 * Webhook per relationship, reconciliation and dispatch (DESIGN.md §5.5).
 *
 * A webhook is created with the data grant (only the creating access may read or update it),
 * scoped by `hooks.webhookScopes`, so a delivery carries scope keys only. The body is
 * unauthenticated: a delivery is a hint, `onChange` reads through the grant. `hookId → userKey`
 * lives in the cluster cache; an unknown hookId hits a negative cache, and the map is rebuilt
 * from the records at most once per minute.
 */
import { randomBytes } from 'node:crypto';
import express from 'express';
import type { Application, Request, Response } from 'express';
import { cacheGet, cacheSet, cacheDel } from '../lib/cache.ts';
import {
  getEntry, saveEntry, listEntries, withLease, againKey, hookKey as HOOK_KEY, forgetHook, record, recordError,
  errorMessage, nowS, type Ctx, type Entry
} from './context.ts';
import { confirm } from './revoke.ts';
import type { ChangeContext } from './types.ts';
import { logKey } from './logKey.ts';

const MISS_KEY = (hookId: string): string => `cmc:hook-miss:${hookId}`;
const REBUILT_KEY = 'cmc:hook-rebuilt';
const REBUILD_EVERY_MS = 60_000;
const HOOK_ID = /^[0-9a-f]{32}$/;

/** Create the relationship's webhook with the grant; records it on `entry` (caller saves). No scopes hook: no webhook. */
export async function createWebhook (ctx: Ctx, entry: Entry): Promise<void> {
  if (!ctx.o.webhooks.enabled || ctx.hooks.webhookScopes == null) return;
  const started = ctx.now();
  const hookId = randomBytes(16).toString('hex');
  const url = `${String(ctx.o.webhooks.publicBaseUrl).replace(/\/+$/, '')}/cmc/hook/${hookId}`;
  try {
    const scopes = ctx.hooks.webhookScopes(ctx.rel(entry));
    const res = await ctx.connectionFor(entry.apiEndpoint).api([{ method: 'webhooks.create', params: { url, scopes } }]);
    const id = res?.[0]?.webhook?.id;
    if (typeof id !== 'string') throw new Error(`webhooks.create: ${res?.[0]?.error?.id ?? 'no webhook returned'}`);
    entry.record.webhook = { id, hookId };
    await cacheSet(HOOK_KEY(hookId), entry.userKey);
    record('cmc:webhook', '2xx', started, ctx);
  } catch (e) {
    record('cmc:webhook', '5xx', started, ctx);
    ctx.logger.warn(`cmc webhook ${logKey(entry.userKey)}: create failed, reconciliation retries: ${errorMessage(e)}`);
  }
}

/** The hookId map, rebuilt from the records at most once per minute (cluster-wide). */
async function lookupHook (ctx: Ctx, hookId: string): Promise<string | null> {
  const known = await cacheGet<string>(HOOK_KEY(hookId));
  if (known != null) return known;
  if (await cacheGet(MISS_KEY(hookId)) != null) return null;
  if (await cacheGet(REBUILT_KEY) == null) {
    await cacheSet(REBUILT_KEY, true, REBUILD_EVERY_MS);
    for (const e of await listEntries(ctx)) {
      if (e.record.webhook != null) await cacheSet(HOOK_KEY(e.record.webhook.hookId), e.userKey);
    }
    const found = await cacheGet<string>(HOOK_KEY(hookId));
    if (found != null) return found;
  }
  await cacheSet(MISS_KEY(hookId), true, REBUILD_EVERY_MS);
  return null;
}

/** `POST /cmc/hook/:hookId`, mounted by `start(app)` only with webhooks on. */
export function mountWebhookRoute (ctx: Ctx, app: Application): void {
  app.post('/cmc/hook/:hookId', express.json({ limit: '64kb' }), async (req: Request, res: Response) => {
    const started = ctx.now();
    const hookId = String(req.params.hookId ?? '');
    let userKey: string | null = null;
    try {
      userKey = HOOK_ID.test(hookId) ? await lookupHook(ctx, hookId) : null;
    } catch (e) {
      ctx.logger.warn(`cmc webhook: lookup failed: ${errorMessage(e)}`);
      record('cmc:webhook', '5xx', started, ctx);
      res.status(503).json({ ok: false });
      return;
    }
    if (userKey == null) {
      record('cmc:webhook', '4xx', started, ctx);
      res.status(404).json({ ok: false });
      return;
    }
    res.status(200).json({ ok: true });
    record('cmc:webhook', '2xx', started, ctx);
    const messages = (req.body as { messages?: unknown })?.messages;
    const scopeKeys = Array.isArray(messages) ? messages.filter((m): m is string => typeof m === 'string') : [];
    dispatch(ctx, userKey, 'webhook', scopeKeys).catch(e => ctx.logger.warn(`cmc dispatch ${logKey(userKey)}: ${errorMessage(e)}`));
  });
}

/** `lastDispatchAt` is saved at most this often (seconds). */
export const DISPATCH_SAVE_EVERY_S = 600;

/**
 * Call `onChange` under the lease. Busy: leave the `again` flag and return; the holder runs once
 * more when it sees it. `modifiedSince` = the previous dispatch minus 60 s.
 */
export async function dispatch (ctx: Ctx, userKey: string, reason: ChangeContext['reason'], scopeKeys?: string[]): Promise<'done' | 'coalesced' | 'none'> {
  const onChange = ctx.hooks.onChange;
  if (onChange == null) return 'none';
  const started = ctx.now();
  let status: '2xx' | '5xx' = '2xx';
  const res = await withLease(ctx, userKey, async () => {
    let current: { reason: ChangeContext['reason'], scopeKeys?: string[] } = { reason, scopeKeys };
    for (let round = 0; round < 10; round++) {
      await cacheDel(againKey(userKey));
      const entry = await getEntry(userKey);
      if (entry == null) return 'none' as const;
      const last = entry.record.lastDispatchAt;
      const at = nowS(ctx);
      const c: ChangeContext = { reason: current.reason, modifiedSince: typeof last === 'number' ? last - 60 : null };
      if (current.scopeKeys != null) c.scopeKeys = current.scopeKeys;
      try {
        await onChange(ctx.rel(entry), c);
        // on the record, under the lease: the module never writes the plugin's state event. At most every
        // DISPATCH_SAVE_EVERY_S: a save rewrites the credential event, and with a 15 s reconcile that was an idle
        // bridge's only write (B-2026-11-24-14). An older value only moves `modifiedSince` earlier: a wider read.
        if (typeof last !== 'number' || at - last >= DISPATCH_SAVE_EVERY_S) {
          entry.record.lastDispatchAt = at;
          await saveEntry(entry);
        }
      } catch (e) {
        status = '5xx';
        ctx.logger.warn(`cmc dispatch ${logKey(userKey)}: onChange failed: ${errorMessage(e)}`);
      }
      if (await cacheGet(againKey(userKey)) == null) break;
      current = { reason: 'again' };
    }
    return 'done' as const;
  });
  if (res.busy) {
    await cacheSet(againKey(userKey), true, ctx.o.leaseTtlMs * 2);
    recordError('cmc_dispatch_coalesced');
    record('cmc:dispatch', '4xx', started, ctx);
    return 'coalesced';
  }
  record('cmc:dispatch', status, started, ctx);
  // A dispatch that arrived between the holder's last flag check and its unlock left the flag.
  if (res.value === 'done' && await cacheGet(againKey(userKey)) != null) return await dispatch(ctx, userKey, 'again');
  return res.value;
}

/**
 * One relationship's reconciliation: `ensureLive`; `onAccepted` again when it had failed; the
 * webhook recreated when missing and reactivated when inactive; then a `poll` dispatch.
 */
export async function reconcileOne (ctx: Ctx, userKey: string): Promise<void> {
  const entry = await getEntry(userKey);
  if (entry == null) return;
  if ((await confirm(ctx, entry)).state === 'gone') return;
  if (!entry.record.acceptHookDone || (ctx.o.webhooks.enabled && ctx.hooks.webhookScopes != null)) {
    await withLease(ctx, userKey, async () => {
      const e = await getEntry(userKey);
      if (e == null || e.record.generation !== entry.record.generation) return;
      let dirty = false;
      if (!e.record.acceptHookDone && ctx.hooks.onAccepted != null) {
        try {
          await ctx.hooks.onAccepted(ctx.rel(e), { replaced: false });
          e.record.acceptHookDone = true;
          dirty = true;
        } catch (err) {
          ctx.logger.warn(`cmc reconcile ${logKey(userKey)}: onAccepted failed again: ${errorMessage(err)}`);
        }
      } else if (!e.record.acceptHookDone) {
        e.record.acceptHookDone = true;
        dirty = true;
      }
      if (await checkWebhook(ctx, e)) dirty = true;
      if (dirty) await saveEntry(e);
    });
  }
  await dispatch(ctx, userKey, 'poll');
}

/** True when the record's webhook changed. */
async function checkWebhook (ctx: Ctx, e: Entry): Promise<boolean> {
  if (!ctx.o.webhooks.enabled || ctx.hooks.webhookScopes == null) return false;
  const before = e.record.webhook;
  if (before == null) {
    await createWebhook(ctx, e);
    return e.record.webhook != null;
  }
  const started = ctx.now();
  const conn = ctx.connectionFor(e.apiEndpoint);
  const res = await conn.api([{ method: 'webhooks.getOne', params: { id: before.id } }]);
  const error = res?.[0]?.error;
  if (error?.id === 'unknown-resource') {
    await forgetHook(before.hookId);
    e.record.webhook = null;
    await createWebhook(ctx, e);
    recordError('cmc_webhook_recreated');
    return true;
  }
  if (error != null) {
    record('cmc:webhook', '5xx', started, ctx);
    return false;
  }
  await cacheSet(HOOK_KEY(before.hookId), e.userKey);
  if (res[0]?.webhook?.state === 'inactive') {
    const upd = await conn.api([{ method: 'webhooks.update', params: { id: before.id, update: { state: 'active' } } }]);
    if (upd?.[0]?.error == null) {
      recordError('cmc_webhook_reactivated');
      record('cmc:webhook', '2xx', started, ctx);
    } else {
      record('cmc:webhook', '5xx', started, ctx);
    }
  }
  return false;
}
