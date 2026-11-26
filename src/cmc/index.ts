/**
 * CMC relationship module for collector-side bridges (plan 129, DESIGN.md).
 *
 *   const cmcRel = createCmcRelationships({ hooks, ... });   // options override config `cmc:`
 *   await cmcRel.start(app);   // in PluginBridge.init, before observability collects the routes
 *
 * Periodic work (inbox, scope answers, reconciliation) runs on the scheduler worker only;
 * everything touching one relationship runs under its owned, generation-checked lease.
 */
import type { Application } from 'express';
import boiler from 'dev-boiler';
import { CmcRelationshipError, createContext, getEntry, listEntries, record, errorMessage, type Ctx, type Entry } from './context.ts';
import { inboxTick } from './inbox.ts';
import { scopeTick, widen, replace, requestDataSet, openRequest } from './scope.ts';
import { ensureLive, firstConnectAllowed, reportAccessError, revoke } from './revoke.ts';
import { mountWebhookRoute, reconcileOne } from './webhook.ts';
import { publishStatus, sendAlert, settleStatusWrites } from './status.ts';
import { createInvite, checkScope, newScopeState } from './invite.ts';
import { bindConversation } from './conversation.ts';
import type { CmcRelationship, CmcRelationships, CmcRelationshipsOptions, CmcRelationshipRecord } from './types.ts';
import { logKey } from './logKey.ts';

const { getConfig } = boiler;

const SCOPE_PROBE_MS = 60_000;

function deepFreeze<T> (o: T): T {
  if (o != null && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

function makeRelationship (ctx: Ctx, entry: Entry): CmcRelationship {
  const { userKey, apiEndpoint } = entry;
  const snapshot = deepFreeze(structuredClone(entry.record)) as Readonly<CmcRelationshipRecord>;
  return {
    userKey,
    record: snapshot,
    connection: () => ctx.connectionFor(apiEndpoint) as any,
    scope: {
      widen: (add, opts) => widen(ctx, userKey, add, opts),
      replace: (full, opts) => replace(ctx, userKey, full, opts),
      requestDataSet: (formSpec, opts) => requestDataSet(ctx, userKey, formSpec, opts),
      pending: () => openRequest(ctx, entry)
    },
    status: (outcome) => publishStatus(ctx, entry, outcome),
    sendSystemAlert: (a) => sendAlert(ctx, { username: snapshot.username, host: snapshot.host, scopeStreamId: snapshot.scopeStreamId }, a),
    conversation: bindConversation({ person: () => ctx.connectionFor(apiEndpoint), bridge: () => ctx.bridge(), record: snapshot })
  };
}

interface Loop { name: string, everyMs: () => number, run: () => Promise<void>, timer?: NodeJS.Timeout, running?: Promise<void> }

const internals = new WeakMap<CmcRelationships, { ctx: () => Promise<Ctx>, inboxTick: () => Promise<void>, scopeTick: () => Promise<void>, reconcileTick: () => Promise<void> }>();

export function createCmcRelationships (options: CmcRelationshipsOptions): CmcRelationships {
  let ctxPromise: Promise<Ctx> | null = null;
  let lastCtx: Ctx | null = null;
  const scopeState = newScopeState();
  const getCtx = (): Promise<Ctx> => {
    if (ctxPromise == null) {
      ctxPromise = createContext(options).then(ctx => {
        ctx.rel = (entry: Entry) => makeRelationship(ctx, entry);
        lastCtx = ctx;
        return ctx;
      });
      ctxPromise.catch(() => { ctxPromise = null; });
    }
    return ctxPromise;
  };

  const timers = new Set<NodeJS.Timeout>();
  const later = (ms: number, fn: () => void): void => {
    const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
    t.unref();
    timers.add(t);
  };

  /** Each relationship at its own offset, spread over the period. */
  const reconcileTick = async (): Promise<void> => {
    const ctx = await getCtx();
    const entries = await listEntries(ctx);
    const step = entries.length > 0 ? ctx.o.reconcileMs / entries.length : 0;
    entries.forEach((e, i) => later(Math.floor(i * step), () => {
      reconcileOne(ctx, e.userKey).catch(err => ctx.logger.warn(`cmc reconcile ${logKey(e.userKey)}: ${errorMessage(err)}`));
    }));
  };

  const loops: Loop[] = [];
  let started = false;

  const runLoop = (ctx: Ctx, loop: Loop): void => {
    if (loop.running != null) return; // never overlap
    const t0 = ctx.now();
    loop.running = loop.run()
      .catch(e => {
        ctx.logger.warn(`cmc ${loop.name}: ${errorMessage(e)}`);
        if (loop.name === 'inbox') record('cmc:inbox-poll', '5xx', t0, ctx);
      })
      .finally(() => { loop.running = undefined; });
  };

  const instance: CmcRelationships = {
    async start (app?: Application) {
      if (started) return;
      const config = await getConfig();
      if (config.get('cmc:enabled') !== true) throw new Error('cmc:enabled must be true: the {main}-cmc stream holds the inbox cursor');
      const ctx = await getCtx();
      started = true;
      if (ctx.o.webhooks.enabled) {
        if (app == null) throw new Error('cmc: webhooks are enabled, start(app) needs the express app');
        mountWebhookRoute(ctx, app);
      }
      // every worker answers health: probe until the scope resolves once
      const probe = (): void => {
        checkScope(ctx, scopeState).then(ok => { if (!ok && started) later(SCOPE_PROBE_MS, probe); }).catch(() => {});
      };
      probe();
      if (!ctx.isScheduler()) return;
      loops.push(
        { name: 'inbox', everyMs: () => ctx.o.inbox.intervalMs, run: () => inboxTick(ctx) },
        { name: 'scope', everyMs: () => ctx.o.scopePollMs, run: () => scopeTick(ctx) },
        { name: 'reconcile', everyMs: () => ctx.o.reconcileMs, run: reconcileTick }
      );
      for (const loop of loops) {
        loop.timer = setInterval(() => runLoop(ctx, loop), loop.everyMs());
        loop.timer.unref();
      }
      runLoop(ctx, loops[0]!); // catch up on the inbox right away
    },

    async stop () {
      started = false;
      for (const loop of loops) if (loop.timer != null) clearInterval(loop.timer);
      for (const t of timers) clearTimeout(t);
      timers.clear();
      await Promise.allSettled(loops.map(l => l.running).filter(p => p != null));
      loops.length = 0;
      await settleStatusWrites();
    },

    health () {
      const seen = lastCtx?.seen;
      return {
        scope: { ...scopeState.health },
        activeRelationships: seen?.activeRelationships ?? null,
        inboxLagS: seen?.cursor != null ? Math.max(0, Math.round(lastCtx!.now() / 1000 - seen.cursor)) : null
      };
    },

    async createInvite (p) {
      return await createInvite(await getCtx(), scopeState, p ?? {});
    },

    async get (userKey) {
      const ctx = await getCtx();
      const entry = await getEntry(userKey);
      return entry == null ? null : ctx.rel(entry);
    },

    async byRelationshipId (id) {
      const ctx = await getCtx();
      const entry = (await listEntries(ctx)).find(e => e.record.relationshipId === id);
      return entry == null ? null : ctx.rel(entry);
    },

    async ensureLive (userKey) { return await ensureLive(await getCtx(), userKey); },
    async firstConnectAllowed (userKey) { return await firstConnectAllowed(await getCtx(), userKey); },
    async reportAccessError (userKey, err) { return await reportAccessError(await getCtx(), userKey, err); },
    async revoke (userKey) { await revoke(await getCtx(), userKey); }
  };

  internals.set(instance, {
    ctx: getCtx,
    inboxTick: async () => inboxTick(await getCtx()),
    scopeTick: async () => scopeTick(await getCtx()),
    reconcileTick
  });
  return instance;
}

/** Tests only: the instance's context and one run of each loop. */
export function _testInternals (instance: CmcRelationships) {
  const i = internals.get(instance);
  if (i == null) throw new Error('not a CMC relationships instance');
  return { ...i, reconcileOne: async (userKey: string) => reconcileOne(await i.ctx(), userKey) };
}

export { CmcRelationshipError };
export type * from './types.ts';
