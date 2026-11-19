/**
 * Accept arrivals (DESIGN.md §5.2 steps 5-10). Identity comes from the server, never from the
 * accept's client-asserted `from`: the grant's access-info gives the username, the endpoint host
 * must be this platform's, and the invite is cross-checked by its server-stamped
 * `backChannelAccessId`. `from` is only a filter (a mismatch refuses).
 *
 * A re-accept by the same person swaps the credential and sends NO revoke: a CMC revoke names the
 * shared back-channel and would sweep the new grant too (open-pryv.io `handleIncomingRevoke`).
 */
import { cmc, cmcScope } from 'hds-lib';
import { readAccessInfo } from '../lib/grantState.ts';
import { isValidCmcUserKey } from '../lib/bridgeAccount.ts';
import {
  getEntry, saveEntry, listEntries, withLease, hostAllowed, forgetHook, record, recordError, errorMessage,
  type Ctx, type Entry
} from './context.ts';
import { teardownLocked } from './revoke.ts';
import { createWebhook } from './webhook.ts';
import { publishStatus, sendAlert } from './status.ts';
import type { CmcRelationshipRecord } from './types.ts';

export type RefusalReason = 'host' | 'unknown_invite' | 'wrong_person' | 'key';
export type ArrivalOutcome = 'done' | 'skip' | 'retry' | { refused: RefusalReason };

/** Where the expected username of an invite lives: `requesterMeta.hdsExpectedUsername` ('' = none). */
export const EXPECTED_USERNAME_KEY = 'hdsExpectedUsername';

const REFUSAL_ALERT = {
  level: 'warning' as const,
  title: { en: 'Connection not completed' },
  body: { en: 'This connection could not be completed and has been ended. Please start again from the service you were connecting.' }
};

interface Verified {
  relationshipId: string;
  apiEndpoint: string;
  username: string;
  host: string;
  dataGrantAccessId: string;
  grantedPermissions: CmcRelationshipRecord['grantedPermissions'];
  inviteEventId: string;
  acceptEventId: string | null;
}

/** The expected username an invite trigger carries, or null. Legacy (mira) invites: their displayName. */
export function expectedUsernameOf (trigger: any): string | null {
  const meta = trigger?.content?.requesterMeta ?? {};
  const v = Object.hasOwn(meta, EXPECTED_USERNAME_KEY) ? meta[EXPECTED_USERNAME_KEY] : meta.displayName;
  return typeof v === 'string' && v !== '' ? v : null;
}

async function verify (ctx: Ctx, event: any): Promise<Verified | 'skip' | 'retry' | { refused: RefusalReason }> {
  const c = event?.content ?? {};
  const apiEndpoint = c.grantedAccess?.apiEndpoint;
  const relationshipId = c.backChannelAccessId;
  if (typeof apiEndpoint !== 'string' || typeof relationshipId !== 'string' || relationshipId === '') {
    ctx.logger.warn(`cmc accept ${event?.id}: no grant or back-channel on the arrival, skipped`);
    return 'skip';
  }
  if (!hostAllowed(ctx, apiEndpoint)) return { refused: 'host' };

  const ai = await readAccessInfo(ctx.connectionFor(apiEndpoint));
  // gone: a dead grant, e.g. a replayed old accept
  if (ai.state !== 'live') return ai.state === 'gone' ? 'skip' : 'retry';
  const username = ai.info?.user?.username;
  const dataGrantAccessId = ai.info?.id;
  if (typeof username !== 'string' || username === '' || typeof dataGrantAccessId !== 'string') return { refused: 'wrong_person' };
  // The core keys the relationship's streams on `from`: one naming someone else is refused.
  const from = c.from ?? {};
  if (from.username !== username || typeof from.host !== 'string' || from.host === '') return { refused: 'wrong_person' };

  // The invite: on this account, under this app scope, stamped with this back-channel.
  const inviteEventId = c.inviteEventId;
  if (typeof inviteEventId !== 'string' || inviteEventId === '') return { refused: 'unknown_invite' };
  const got = await ctx.bridge().api([{ method: 'events.getOne', params: { id: inviteEventId } }]);
  const err = got?.[0]?.error;
  if (err?.id === 'unknown-resource' || err?.id === 'forbidden') return { refused: 'unknown_invite' };
  if (err != null) return 'retry';
  const trigger = got[0].event;
  if (trigger?.type !== 'consent/request-cmc' || !(trigger.streamIds ?? []).includes(ctx.o.scopeStreamId)) return { refused: 'unknown_invite' };
  if (trigger.content?.backChannelAccessId !== relationshipId) return { refused: 'unknown_invite' };
  const expected = expectedUsernameOf(trigger);
  if (expected != null && expected !== username) return { refused: 'wrong_person' };

  return {
    relationshipId,
    apiEndpoint,
    username,
    host: from.host,
    dataGrantAccessId,
    grantedPermissions: cmcScope.personPermissions(ai.info.permissions ?? []),
    inviteEventId,
    acceptEventId: typeof c.acceptEventId === 'string' ? c.acceptEventId : null
  };
}

export function defaultUserKey (id: { username: string, host: string }): string {
  return cmc.counterpartySlug(id);
}

/** One `consent/accept-cmc` arrival. Never throws for a refusal; throws (→ retry) on a transient failure. */
export async function processAccept (ctx: Ctx, event: any): Promise<ArrivalOutcome> {
  const started = ctx.now();
  const v = await verify(ctx, event);
  if (v === 'skip' || v === 'retry') {
    if (v === 'skip') record('cmc:accept', '4xx', started, ctx);
    return v;
  }
  if ('refused' in v) return await refuse(ctx, event, v.refused, started);

  const userKey = (ctx.hooks.userKeyFor ?? defaultUserKey)({ username: v.username, host: v.host });
  if (!isValidCmcUserKey(userKey)) return await refuse(ctx, event, 'key', started);

  const res = await withLease(ctx, userKey, () => store(ctx, userKey, event, v));
  if (res.busy) return 'retry';
  record('cmc:accept', res.value === 'done' ? '2xx' : '4xx', started, ctx);
  return res.value;
}

async function store (ctx: Ctx, userKey: string, event: any, v: Verified): Promise<'done' | 'skip' | 'retry'> {
  const acceptedAt: number = typeof event.time === 'number' ? event.time : 0;
  let existing = await getEntry(userKey);
  if (existing?.record.generation === event.id) return 'done';
  if (existing != null && existing.record.acceptedAt > acceptedAt) return 'skip'; // never older over newer

  if (existing != null && existing.record.relationshipId !== v.relationshipId) {
    // A stale record of an ended relationship meets a new one: end the old one first.
    const st = await readAccessInfo(ctx.connectionFor(existing.apiEndpoint));
    if (st.state === 'unknown') return 'retry';
    if (st.state === 'gone') {
      const t = await teardownLocked(ctx, userKey, existing.record.generation, 'grant-gone');
      if (t === 'hook-failed') return 'retry';
      existing = null;
    } else {
      ctx.logger.warn(`cmc accept ${userKey}: relationship ${v.relationshipId} replaces live ${existing.record.relationshipId}`);
    }
  }
  const replaced = existing != null;
  // the old grant's webhook now answers 404, so the core deactivates it
  if (existing?.record.webhook != null) await forgetHook(existing.record.webhook.hookId);

  const rec: CmcRelationshipRecord = {
    v: 1,
    relationshipId: v.relationshipId,
    generation: event.id,
    acceptedAt,
    inviteEventId: v.inviteEventId,
    acceptEventId: v.acceptEventId,
    dataGrantAccessId: v.dataGrantAccessId,
    username: v.username,
    host: v.host,
    scopeStreamId: ctx.o.scopeStreamId,
    collectorStreamId: cmc.collectorStreamUnder(ctx.o.scopeStreamId, cmc.counterpartySlug({ username: v.username, host: v.host })),
    grantedPermissions: v.grantedPermissions,
    // the request lives on the collectors stream, not on the grant: it survives the swap
    pendingScopeRequest: existing?.record.pendingScopeRequest ?? null,
    // the old webhook belongs to the old grant (only its creator may read it): a new one is made
    webhook: null,
    acceptHookDone: ctx.hooks.onAccepted == null,
    lastDispatchAt: existing?.record.lastDispatchAt ?? null
  };
  const entry: Entry = { userKey, apiEndpoint: v.apiEndpoint, record: rec };
  await saveEntry(entry);
  ctx.logger.info(`cmc accept ${userKey}: relationship ${rec.relationshipId} stored (arrival ${rec.generation}${replaced ? ', replaces the previous grant' : ''})`);

  // connected at the arrival's time: a replay cannot revive a disconnected status
  await publishStatus(ctx, entry, { kind: 'connected', at: acceptedAt });
  await createWebhook(ctx, entry);
  if (entry.record.webhook != null) await saveEntry(entry);

  if (ctx.hooks.onAccepted != null) {
    try {
      await ctx.hooks.onAccepted(ctx.rel(entry), { replaced });
      entry.record.acceptHookDone = true;
      await saveEntry(entry);
    } catch (e) {
      ctx.logger.warn(`cmc accept ${userKey}: onAccepted failed, reconciliation retries: ${errorMessage(e)}`);
    }
  }
  return 'done';
}

/**
 * Nothing stored. When no live record holds this relationship: a value-free alert FIRST, then a
 * revoke by accessId (the `{inviteEventId}` form only scans the newest 200 inbox accepts).
 */
async function refuse (ctx: Ctx, event: any, reason: RefusalReason, started: number): Promise<ArrivalOutcome> {
  recordError(`cmc_accept_${reason}`);
  record('cmc:accept', '4xx', started, ctx);
  const c = event?.content ?? {};
  const relationshipId = c.backChannelAccessId;
  ctx.logger.warn(`cmc accept: arrival ${event?.id} refused (${reason}), relationship ${relationshipId}`);
  if (typeof relationshipId !== 'string' || relationshipId === '') return { refused: reason };
  if ((await listEntries(ctx)).some(e => e.record.relationshipId === relationshipId)) return { refused: reason };
  const from = c.from;
  if (typeof from?.username === 'string' && typeof from?.host === 'string') {
    try {
      await sendAlert(ctx, { username: from.username, host: from.host, scopeStreamId: ctx.o.scopeStreamId }, REFUSAL_ALERT);
    } catch (e) {
      ctx.logger.warn(`cmc accept: refusal alert for ${event?.id} failed: ${errorMessage(e)}`);
    }
  }
  try {
    await cmc.revokeRelationship(ctx.bridge(), { accessId: relationshipId, scopeStreamId: ctx.o.scopeStreamId });
  } catch (e) {
    ctx.logger.warn(`cmc accept: revoke of refused ${relationshipId} failed: ${errorMessage(e)}`);
  }
  return { refused: reason };
}
