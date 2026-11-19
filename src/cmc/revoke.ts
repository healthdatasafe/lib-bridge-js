/**
 * Revocation and teardown (DESIGN.md §5.3). Inbox notices and access errors are only hints:
 * nothing is deleted before access-info on the stored grant says `gone`. Teardown is
 * generation-checked (it acts only on the record confirmed gone, never on a newer accept stored
 * meanwhile), calls `onRevoked` first and keeps the record when that throws, so reconciliation
 * retries it.
 */
import { cmc } from 'hds-lib';
import { grantState } from '../lib/grantState.ts';
import { deleteCredentialFromBridgeAccount } from '../methods/user.ts';
import { cacheDel } from '../lib/cache.ts';
import {
  getEntry, listEntries, withLease, hostAllowed, againKey, forgetHook, record, recordError, errorMessage,
  type Ctx, type Entry
} from './context.ts';
import { publishStatus } from './status.ts';
import type { EndReason } from './types.ts';

export type TeardownResult = 'torn-down' | 'stale' | 'hook-failed';

/** Caller holds the lease. Acts only when the stored generation is `generation`. */
export async function teardownLocked (ctx: Ctx, userKey: string, generation: string, reason: EndReason): Promise<TeardownResult> {
  const entry = await getEntry(userKey);
  if (entry == null || entry.record.generation !== generation) return 'stale';
  try {
    await ctx.hooks.onRevoked(ctx.rel(entry), reason);
  } catch (e) {
    ctx.logger.warn(`cmc teardown ${userKey}: onRevoked failed (${entry.record.relationshipId}), record kept: ${errorMessage(e)}`);
    return 'hook-failed';
  }
  const deleted = await deleteCredentialFromBridgeAccount(userKey, {
    onlyIfClientData: cd => (cd.hdsCmc as { generation?: string } | undefined)?.generation === generation
  });
  if (deleted === 'refused') return 'stale';
  await cacheDel(againKey(userKey));
  if (entry.record.webhook != null) await forgetHook(entry.record.webhook.hookId);
  ctx.logger.info(`cmc teardown ${userKey}: relationship ${entry.record.relationshipId} ended (${reason})`);
  return 'torn-down';
}

/**
 * Confirm `entry`'s grant; when gone, tear it down (under the lease, generation-checked).
 * Returns the grant state and whether the teardown happened.
 */
export async function confirm (ctx: Ctx, entry: Entry): Promise<{ state: 'live' | 'gone' | 'unknown', result: TeardownResult | 'busy' | null }> {
  const state = await grantState(ctx.connectionFor(entry.apiEndpoint));
  if (state !== 'gone') return { state, result: null };
  const started = ctx.now();
  const res = await withLease(ctx, entry.userKey, () => teardownLocked(ctx, entry.userKey, entry.record.generation, 'grant-gone'), ctx.o.leaseTtlMs);
  const result = res.busy ? 'busy' : res.value;
  if (result === 'torn-down') {
    recordError('cmc_revoke_confirmed');
    record('cmc:revoke', '2xx', started, ctx);
  } else if (result === 'hook-failed') {
    record('cmc:revoke', '5xx', started, ctx);
  }
  return { state, result };
}

export async function ensureLive (ctx: Ctx, userKey: string): Promise<boolean> {
  const entry = await getEntry(userKey);
  if (entry == null) return false;
  return (await confirm(ctx, entry)).state !== 'gone';
}

/**
 * mira's first-connect guard: yes when no grant is stored, or when it is gone (torn down, so a
 * reconnect starts from a clean record); no when live or unknown (fail closed). A stored
 * endpoint on a host this bridge does not serve counts as none: the person cannot hold it, so
 * refusing would lock them out for good.
 */
export async function firstConnectAllowed (ctx: Ctx, userKey: string): Promise<boolean> {
  const entry = await getEntry(userKey);
  if (entry == null) return true;
  if (!hostAllowed(ctx, entry.apiEndpoint)) {
    ctx.logger.warn(`cmc first connect ${userKey}: the stored grant is not on this platform, ignored`);
    return true;
  }
  const { state } = await confirm(ctx, entry);
  if (state === 'unknown') ctx.logger.warn(`cmc first connect ${userKey}: refused, the stored grant's state could not be told`);
  return state === 'gone';
}

export async function reportAccessError (ctx: Ctx, userKey: string, _err: unknown): Promise<'live' | 'torn-down' | 'unknown'> {
  const entry = await getEntry(userKey);
  if (entry == null) return 'unknown';
  const { state, result } = await confirm(ctx, entry);
  if (result === 'torn-down') return 'torn-down';
  return state === 'live' ? 'live' : 'unknown';
}

/** Bridge-initiated end: status `disconnected` while the grant still works, the CMC revoke by accessId, then teardown. */
export async function revoke (ctx: Ctx, userKey: string): Promise<void> {
  const started = ctx.now();
  const res = await withLease(ctx, userKey, async () => {
    const entry = await getEntry(userKey);
    if (entry == null) return 'none';
    await publishStatus(ctx, entry, { kind: 'disconnected' });
    await cmc.revokeRelationship(ctx.bridge(), { accessId: entry.record.relationshipId, scopeStreamId: entry.record.scopeStreamId });
    return await teardownLocked(ctx, userKey, entry.record.generation, 'revoked-by-bridge');
  }, ctx.o.leaseTtlMs);
  if (res.busy) throw new Error(`cmc revoke ${userKey}: relationship busy`);
  record('cmc:revoke', res.value === 'hook-failed' ? '5xx' : '2xx', started, ctx);
}

/**
 * An inbox `consent/revoke-cmc`: selects candidates, each confirmed by access-info. `retry` when
 * a candidate's state could not be told or its teardown did not happen.
 */
export async function processRevokeNotice (ctx: Ctx, event: any): Promise<'done' | 'retry'> {
  const notice = cmc.revocationFromEvent(event);
  if (notice.superseded != null) return 'done';
  let retry = false;
  for (const entry of await listEntries(ctx)) {
    const r = entry.record;
    const matches = cmc.revocationMatches(notice, {
      accessId: r.relationshipId,
      acceptEventId: r.acceptEventId ?? undefined,
      inviteEventId: r.inviteEventId ?? undefined,
      scopeStreamId: r.scopeStreamId
    });
    if (!matches) continue;
    const { state, result } = await confirm(ctx, entry);
    if (state === 'unknown' || result === 'busy' || result === 'hook-failed') retry = true;
  }
  return retry ? 'retry' : 'done';
}
