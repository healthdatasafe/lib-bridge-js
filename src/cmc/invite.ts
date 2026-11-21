/**
 * Invites (DESIGN.md §5.1), lifted from bridge-mira's `cmcBridgeMira.ts`: the bare app scope
 * ensured (and probed for `health()`), the invite minted single-use with explicit features, and
 * the patient URL built on `service:patientAppBaseUrl`.
 */
import { cmc, cmcFormSpec } from 'hds-lib';
import { errorMessage, nowS, CmcRelationshipError, type Ctx } from './context.ts';
import { assertWebhooksAllowed } from './scope.ts';
import { EXPECTED_USERNAME_KEY } from './accept.ts';
import type { CmcScopeHealth, CreateInviteParams, CreateInviteResult } from './types.ts';

export interface ScopeState { ready: boolean; health: CmcScopeHealth }

export function newScopeState (): ScopeState {
  return { ready: false, health: { healthy: false, lastCheckedAt: null, lastError: 'not yet checked' } };
}

/**
 * `:_cmc:apps:<appCode>` on the bridge account. hds-lib's `ensureAppScope` does not create the
 * bare scope (the core provisions it only for an access naming the leaf, B-2026-10-02-7), so it
 * is created here once per process. Looked up first: an access holding `manage` on the leaf only
 * (prod mira) may not create under `:_cmc:apps` and gets `forbidden`, not `item-already-exists`.
 */
export async function ensureScope (ctx: Ctx, s: ScopeState): Promise<string> {
  const scope = ctx.o.scopeStreamId;
  if (s.ready) return scope;
  const conn = ctx.bridge();
  const found = await conn.api([{ method: 'streams.get', params: { parentId: scope } }]);
  if (found?.[0]?.error != null) {
    const created = await conn.api([{ method: 'streams.create', params: { id: scope, parentId: ':_cmc:apps', name: ctx.o.appCode } }]);
    const err = created?.[0]?.error;
    if (err != null && err.id !== 'item-already-exists') throw new Error(`CMC scope ${scope}: ${err.id}`);
  }
  s.ready = true;
  return scope;
}

/**
 * First connects are rare, so a broken scope (prod 1.10.6 to 1.10.20) is invisible to traffic
 * alerts: `health()` reports this probe. Never throws.
 */
export async function checkScope (ctx: Ctx, s: ScopeState): Promise<boolean> {
  try {
    await ensureScope(ctx, s);
    if (!s.health.healthy) ctx.logger.info('CMC scope healthy.');
    s.health.healthy = true;
    s.health.lastError = null;
  } catch (e) {
    const error = 'CMC scope: ' + errorMessage(e);
    if (s.health.healthy || s.health.lastError !== error) ctx.logger.error('CMC scope FAULTY, first connects will fail: ' + error);
    s.health.healthy = false;
    s.health.lastError = error;
  }
  s.health.lastCheckedAt = ctx.now();
  return s.health.healthy;
}

/**
 * The patient app on the same platform as `service:serviceInfoURL`. A mismatch is logged, not
 * thrown: a redirect to the wrong platform still completes a flow, which is why the hardcoded
 * demo fallback sent every prod patient to demo until 2026-08-31, so it must be loud.
 */
export function patientUrlFor (ctx: Ctx, capabilityUrl: string): string {
  const base = ctx.o.patientAppBaseUrl;
  if (base == null || base === '') {
    ctx.logger.error('cmc: service:patientAppBaseUrl is not configured, cannot build the patient redirect');
    throw new Error('service:patientAppBaseUrl is not configured');
  }
  if (String(base).includes('demo') !== ctx.o.serviceInfoURL.includes('demo')) {
    ctx.logger.error(`cmc: patientAppBaseUrl (${base}) and serviceInfoURL (${ctx.o.serviceInfoURL}) name different platforms`);
  }
  return `${String(base).replace(/\/$/, '')}/?action=invite&capabilityUrl=${encodeURIComponent(capabilityUrl)}`;
}

export async function createInvite (ctx: Ctx, s: ScopeState, p: CreateInviteParams): Promise<CreateInviteResult> {
  const scopeStreamId = await ensureScope(ctx, s);
  const requestedPermissions = p.requestedPermissions ?? ctx.hooks.requestedPermissions?.();
  if (requestedPermissions == null || requestedPermissions.length === 0) {
    throw new CmcRelationshipError('no-permissions', 'createInvite: no requestedPermissions (param or hooks.requestedPermissions)');
  }
  assertWebhooksAllowed(ctx, requestedPermissions);
  const expected = p.expectedUsername ?? null;
  const params = {
    appCode: ctx.o.appCode,
    scopeStreamId,
    // the bridge's own name, shown to the person ("Invitation from …"): never the expected username, which
    // made the person read her own username as the inviter. The binding is the marker below; accept reads
    // displayName only on a legacy invite that has no marker (mira's earlier invites)
    displayName: ctx.o.invite.displayName,
    // the marker tells a new invite from a legacy one: '' = no expected username
    requesterMeta: { [EXPECTED_USERNAME_KEY]: expected ?? '' },
    requestedPermissions: requestedPermissions as any[],
    mode: 'single-use' as const,
    // explicit: @pryv/cmc defaults both to true, and a chat nobody reads must not be offered
    features: p.features ?? ctx.o.invite.features,
    expiresAt: Math.floor(nowS(ctx)) + (p.expiresInSeconds ?? ctx.o.invite.expiresInSeconds),
    ...(p.consent != null ? { consent: p.consent } : {})
  };
  const result = p.formSpec != null
    ? await cmcFormSpec.createInviteWithFormSpec(ctx.bridge() as any, { ...params, formSpec: p.formSpec } as any)
    : await cmc.createInvite(ctx.bridge(), params as Parameters<typeof cmc.createInvite>[1]);
  return {
    inviteEventId: result.inviteEventId,
    capabilityUrl: result.capabilityUrl,
    patientUrl: patientUrlFor(ctx, result.capabilityUrl),
    expiresAt: result.expiresAt ?? null
  };
}
