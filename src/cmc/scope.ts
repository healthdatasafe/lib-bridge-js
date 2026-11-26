/**
 * Scope updates (DESIGN.md §5.4). Both platform calls replace the grant's permission set, so
 * the module always sends the FULL set; it holds the single open request of a relationship.
 */
import { cmc, cmcScope, cmcFormSpec, type FormSpec } from 'hds-lib';
import { readAccessInfo } from '../lib/grantState.ts';
import {
  CmcRelationshipError, getEntry, saveEntry, listEntries, withLease, nowS, record, recordError, errorMessage,
  type Ctx, type Entry
} from './context.ts';
import type { PendingScopeRequest, ScopeOptions, ScopePermission } from './types.ts';
import { logKey } from './logKey.ts';

/**
 * `want` strictly contains `held`: read < contribute < manage and create-only < contribute <
 * manage; read and create-only are not ordered (open-pryv.io `permissionSet.ts`
 * `capabilitiesForLevel` / `joinLevel`: no level grants exactly both).
 */
export function levelContains (want: string, held: string): boolean {
  if (want === held) return false;
  if (want === 'manage') return true;
  return want === 'contribute' && (held === 'read' || held === 'create-only');
}

/**
 * The permissions a person grants: `personPermissions` (no `:_cmc:*`) without the platform's
 * other `:_` streams. Access-info lists ones the core adds to every access
 * (`:_system:account` at `none`, `:_audit:access-<id>`): they are not part of the grant and
 * must not be sent back in a scope request (hds-lib `isDataStream` draws the same line).
 */
export function dataPermissions (perms: ScopePermission[]): ScopePermission[] {
  return cmcScope.personPermissions(perms).filter(p => p.streamId == null || !p.streamId.startsWith(':_'));
}

/** `current ∪ add` by streamId, no parent folding; refuses a level that does not contain the held one. */
export function unionPermissions (current: ScopePermission[], add: ScopePermission[]): ScopePermission[] {
  const out = dataPermissions(current);
  for (const a of dataPermissions(add)) {
    if (a.streamId == null) {
      const i = out.findIndex(p => p.streamId == null && p.feature === a.feature);
      if (i < 0) out.push(a); else out[i] = a;
      continue;
    }
    const i = out.findIndex(p => p.streamId === a.streamId);
    if (i < 0) { out.push(a); continue; }
    const held = out[i]!.level ?? 'read';
    const want = a.level ?? 'read';
    if (held === want) continue;
    if (!levelContains(want, held)) {
      throw new CmcRelationshipError('scope-level-conflict', `stream "${a.streamId}" is granted at "${held}", "${want}" does not contain it`);
    }
    out[i] = { streamId: a.streamId, level: want };
  }
  return out;
}

/** A set disabling webhooks would silently turn §5.5 off: refused while webhooks are on. */
export function assertWebhooksAllowed (ctx: Ctx, perms: ScopePermission[]): void {
  if (!ctx.o.webhooks.enabled) return;
  const bad = perms.find(p => (p.feature === 'webhooks' || p.feature === 'accessCreation') && p.setting === 'forbidden');
  if (bad != null) throw new CmcRelationshipError('webhooks-forbidden', `"${bad.feature}: forbidden" disables the relationship's webhook`);
}

export function openRequest (ctx: Ctx, entry: Entry): PendingScopeRequest | null {
  const p = entry.record.pendingScopeRequest;
  return p != null && p.expires > nowS(ctx) ? p : null;
}

type Build = (entry: Entry) => Promise<{ kind: 'plain' | 'dataset', permissions: ScopePermission[], send: (expires: number) => Promise<{ id: string, remote: string | null }> }>;

/** Check and send under the lease: one open request per relationship. */
async function propose (ctx: Ctx, userKey: string, opts: ScopeOptions, build: Build): Promise<PendingScopeRequest> {
  const started = ctx.now();
  const res = await withLease(ctx, userKey, async () => {
    const entry = await getEntry(userKey);
    if (entry == null) throw new CmcRelationshipError('unknown-relationship', `no CMC relationship for ${logKey(userKey)}`);
    if (openRequest(ctx, entry) != null && opts.supersede !== true) {
      recordError('cmc_scope_request_open');
      throw new CmcRelationshipError('scope-request-open', `a scope request of ${logKey(userKey)} is pending`);
    }
    const b = await build(entry);
    assertWebhooksAllowed(ctx, b.permissions);
    const expires = Math.round(nowS(ctx) + (opts.expiresInSeconds ?? cmcScope.DATASET_REQUEST_TTL_SEC));
    const sent = await b.send(expires);
    const pending: PendingScopeRequest = {
      scopeRequestEventId: sent.id,
      remoteScopeRequestEventId: sent.remote,
      kind: b.kind,
      permissions: b.permissions,
      sentAt: nowS(ctx),
      expires
    };
    entry.record.pendingScopeRequest = pending;
    await saveEntry(entry);
    return pending;
  }, ctx.o.leaseTtlMs);
  if (res.busy) throw new CmcRelationshipError('relationship-busy', `relationship ${logKey(userKey)} is busy`);
  record('cmc:scope-request', '2xx', started, ctx);
  return res.value;
}

/** The pending id of a request written but not delivered yet; rethrows anything else. */
function pendingIdOf (e: unknown): string {
  const err = e as { id?: string, cause?: { scopeRequestEventId?: string }, innerObject?: { reason?: string, scopeRequestEventId?: string } };
  const id = err?.id === 'cmc-scope-request-delivery-pending'
    ? err.cause?.scopeRequestEventId
    : err?.innerObject?.reason === 'delivery-pending' ? err.innerObject.scopeRequestEventId : undefined;
  if (typeof id !== 'string') throw e;
  return id;
}

function plainSender (ctx: Ctx, entry: Entry, permissions: ScopePermission[], opts: ScopeOptions) {
  return async (expires: number) => {
    try {
      const r = await cmc.proposeScopeUpdate(ctx.bridge(), {
        collectorStreamId: entry.record.collectorStreamId,
        newPermissions: permissions as any,
        message: opts.message,
        expires,
        waitForDelivery: true
      });
      return { id: r.scopeRequestEventId, remote: r.remoteScopeRequestEventId };
    } catch (e) {
      return { id: pendingIdOf(e), remote: null };
    }
  };
}

export async function widen (ctx: Ctx, userKey: string, add: ScopePermission[], opts: ScopeOptions = {}): Promise<PendingScopeRequest> {
  return await propose(ctx, userKey, opts, async (entry) => {
    // From access-info read just before sending, so nothing is dropped by omission.
    const ai = await readAccessInfo(ctx.connectionFor(entry.apiEndpoint));
    if (ai.state !== 'live') throw new CmcRelationshipError(`grant-${ai.state}`, `the grant of ${logKey(userKey)} is ${ai.state}`);
    const permissions = unionPermissions(ai.info.permissions ?? [], add);
    return { kind: 'plain', permissions, send: plainSender(ctx, entry, permissions, opts) };
  });
}

export async function replace (ctx: Ctx, userKey: string, full: ScopePermission[], opts: ScopeOptions = {}): Promise<PendingScopeRequest> {
  return await propose(ctx, userKey, opts, async (entry) => {
    const permissions = dataPermissions(full);
    return { kind: 'plain', permissions, send: plainSender(ctx, entry, permissions, opts) };
  });
}

export async function requestDataSet (ctx: Ctx, userKey: string, formSpec: FormSpec, opts: ScopeOptions = {}): Promise<PendingScopeRequest> {
  return await propose(ctx, userKey, opts, async (entry) => {
    const permissions = cmcFormSpec.deriveCmcPermissions(cmcFormSpec.formSpecForPerson(formSpec)) as ScopePermission[];
    return {
      kind: 'dataset',
      permissions,
      send: async (expires: number) => {
        try {
          const r = await cmcScope.proposeDataSetUpdate(ctx.bridge() as any, entry.record.collectorStreamId, formSpec, {
            newPermissions: permissions, message: opts.message, expires, waitForDelivery: true
          });
          return { id: r.scopeRequestEventId, remote: r.remoteScopeRequestEventId };
        } catch (e) {
          return { id: pendingIdOf(e), remote: null };
        }
      }
    };
  });
}

/** Scheduler loop: the answer to each open request (newest 20 on the collectors stream). */
export async function scopeTick (ctx: Ctx): Promise<void> {
  for (const entry of await listEntries(ctx)) {
    if (entry.record.pendingScopeRequest == null) continue;
    try {
      await checkAnswer(ctx, entry);
    } catch (e) {
      ctx.logger.warn(`cmc scope ${logKey(entry.userKey)}: answer check failed: ${errorMessage(e)}`);
    }
  }
}

async function checkAnswer (ctx: Ctx, seen: Entry): Promise<void> {
  const pending = seen.record.pendingScopeRequest!;
  const requests = await cmcScope.listScopeRequests(ctx.bridge() as any, seen.record.collectorStreamId, { limit: 20 });
  const r = requests.find(x => x.id === pending.scopeRequestEventId);
  let answer: 'accepted' | 'refused' | 'expired' | null = r?.answer === 'accepted' || r?.answer === 'refused' ? r.answer : null;
  if (answer == null && pending.expires <= nowS(ctx)) answer = 'expired';
  const remote = r?.remoteEventId ?? null;
  if (answer == null && (remote == null || remote === pending.remoteScopeRequestEventId)) return;

  const done = await withLease(ctx, seen.userKey, async () => {
    const entry = await getEntry(seen.userKey);
    const p = entry?.record.pendingScopeRequest;
    if (entry == null || p?.scopeRequestEventId !== pending.scopeRequestEventId) return null;
    if (answer == null) {
      p.remoteScopeRequestEventId = remote;
      await saveEntry(entry);
      return null;
    }
    const ai = await readAccessInfo(ctx.connectionFor(entry.apiEndpoint));
    if (ai.state === 'live') entry.record.grantedPermissions = dataPermissions(ai.info.permissions ?? []);
    entry.record.pendingScopeRequest = null;
    await saveEntry(entry);
    return entry;
  });
  if (done.busy || done.value == null || answer == null) return;
  const entry = done.value;
  try {
    await ctx.hooks.onScopeAnswer?.(ctx.rel(entry), {
      answer, scopeRequestEventId: pending.scopeRequestEventId, permissions: entry.record.grantedPermissions
    });
  } catch (e) {
    ctx.logger.warn(`cmc scope ${logKey(entry.userKey)}: onScopeAnswer failed for ${pending.scopeRequestEventId}: ${errorMessage(e)}`);
  }
}
