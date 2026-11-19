/**
 * Public types of the CMC relationship module (plan 129, DESIGN.md §4 and §6).
 */
import type { Application } from 'express';
import type { pryv, ScopePermission, FormSpec } from 'hds-lib';
import type { ConnectorOutcome } from '../lib/connectorStatus.ts';

export type { ScopePermission };

/** The relationship record, stored as `clientData.hdsCmc` on the credential event. Never an apiEndpoint or token. */
export interface CmcRelationshipRecord {
  v: 1;
  /** The bridge-side back-channel access id: stable for the life of the relationship. */
  relationshipId: string;
  /** The accept arrival (inbox event) this record was built from. */
  generation: string;
  /** The arrival's time, Pryv seconds. */
  acceptedAt: number;
  inviteEventId: string | null;
  acceptEventId: string | null;
  dataGrantAccessId: string;
  username: string;
  host: string;
  scopeStreamId: string;
  collectorStreamId: string;
  grantedPermissions: ScopePermission[];
  pendingScopeRequest: null | PendingScopeRequest;
  webhook: null | { id: string; hookId: string };
  acceptHookDone: boolean;
  /** Pryv seconds: start of the last successful `onChange` dispatch; absent/null before the first. */
  lastDispatchAt?: number | null;
}

export interface PendingScopeRequest {
  scopeRequestEventId: string;
  remoteScopeRequestEventId: string | null;
  kind: 'plain' | 'dataset';
  permissions: ScopePermission[];
  /** Pryv seconds. */
  sentAt: number;
  /** Pryv seconds. */
  expires: number;
}

export interface ScopeOptions {
  message?: Record<string, string>;
  expiresInSeconds?: number;
  /** Send even while an earlier request is pending (the platform supersedes a delivered one). */
  supersede?: boolean;
}

export interface CmcRelationship {
  readonly userKey: string;
  readonly record: Readonly<CmcRelationshipRecord>;
  /** A connection over the data grant; the endpoint is not exposed otherwise. */
  connection (): pryv.Connection;
  scope: {
    /** Full set = granted ∪ add (read from access-info just before sending). */
    widen (add: ScopePermission[], opts?: ScopeOptions): Promise<PendingScopeRequest>;
    /** An explicit full set (may narrow). */
    replace (full: ScopePermission[], opts?: ScopeOptions): Promise<PendingScopeRequest>;
    /** A data-set update (`cmcScope.proposeDataSetUpdate`). */
    requestDataSet (formSpec: FormSpec, opts?: ScopeOptions): Promise<PendingScopeRequest>;
    /** The open request, or null (none, or expired). */
    pending (): PendingScopeRequest | null;
  };
  /** Connector status on `hooks.statusStreamId` (no leaf: no-op). Never throws, bounded to 5 s. */
  status (outcome: ConnectorOutcome): Promise<void>;
  /** A value-free system alert to the person. */
  sendSystemAlert (a: SystemAlert): Promise<void>;
}

export interface SystemAlert {
  level?: 'info' | 'warning' | 'critical';
  title: Record<string, string>;
  body: Record<string, string>;
}

export type EndReason = 'grant-gone' | 'revoked-by-bridge';

export interface ChangeContext {
  reason: 'webhook' | 'poll' | 'again';
  /** The webhook's matched scope keys (webhook deliveries only). */
  scopeKeys?: string[];
  /** Pryv seconds: the previous dispatch minus 60 s; null on the first one. */
  modifiedSince: number | null;
}

export interface ScopeAnswer {
  answer: 'accepted' | 'refused' | 'expired';
  scopeRequestEventId: string;
  /** What the grant holds now (refreshed from access-info). */
  permissions: ScopePermission[];
}

export type WebhookScopes = Record<string, { kind: 'events'; query: { streams: string[] } }>;

export interface CmcHooks {
  /** Storage key from the VERIFIED identity. Default `cmc.counterpartySlug({ username, host })`. */
  userKeyFor? (id: { username: string; host: string }): string;
  /** Default permissions of an invite. */
  requestedPermissions? (): ScopePermission[];
  /** Scopes of the relationship's webhook (`cmc:webhooks:enabled`); none: no webhook, poll only. */
  webhookScopes? (rel: CmcRelationship): WebhookScopes;
  /** Connector status leaf (e.g. `sync-status-mira`); unset: `rel.status` is a no-op. */
  statusStreamId?: string;
  /** After an accept is stored. On throw, reconciliation calls it again (`replaced: false`). */
  onAccepted? (rel: CmcRelationship, ctx: { replaced: boolean }): Promise<void>;
  /** Short and idempotent: enqueue and return. */
  onChange? (rel: CmcRelationship, c: ChangeContext): Promise<void>;
  onScopeAnswer? (rel: CmcRelationship, a: ScopeAnswer): Promise<void>;
  /** Required. Called before teardown; on throw the record stays live and reconciliation retries. Never called on a replace. */
  onRevoked (rel: CmcRelationship, reason: EndReason): Promise<void>;
}

export interface CmcScopeHealth {
  healthy: boolean;
  lastCheckedAt: number | null;
  lastError: string | null;
}

export interface CreateInviteParams {
  /** The person expected to accept; written as the invite's displayName and checked at accept. */
  expectedUsername?: string;
  requestedPermissions?: ScopePermission[];
  consent?: Record<string, string>;
  formSpec?: FormSpec;
  expiresInSeconds?: number;
  features?: { chat?: boolean; systemMessaging?: boolean };
}

export interface CreateInviteResult {
  inviteEventId: string;
  capabilityUrl: string;
  patientUrl: string;
  expiresAt: number | null;
}

export interface CmcRelationships {
  /** Mounts `/cmc/hook/:hookId` (webhooks on) and starts the loops (scheduler worker). */
  start (app?: Application): Promise<void>;
  stop (): Promise<void>;
  health (): { scope: CmcScopeHealth; activeRelationships: number | null; inboxLagS: number | null };
  createInvite (p: CreateInviteParams): Promise<CreateInviteResult>;
  get (userKey: string): Promise<CmcRelationship | null>;
  byRelationshipId (id: string): Promise<CmcRelationship | null>;
  /** False when the grant is gone (and tears down); true when live or not known. */
  ensureLive (userKey: string): Promise<boolean>;
  /** True when no grant is stored or the stored one is gone (torn down); false when live or unknown. */
  firstConnectAllowed (userKey: string): Promise<boolean>;
  reportAccessError (userKey: string, err: unknown): Promise<'live' | 'torn-down' | 'unknown'>;
  revoke (userKey: string): Promise<void>;
}

/** Minimal connection shape the module uses (a `pryv.Connection` fits). */
export interface CmcConnection {
  api (calls: any[]): Promise<any[]>;
  apiOne (method: string, params: any, resultKey?: string): Promise<any>;
}

export interface CmcRelationshipsOptions {
  hooks: CmcHooks;
  /** `cmc:appCode`. */
  appCode?: string;
  /** The bridge account's connection. Default: the lib's bridge account. */
  bridgeConnection?: () => unknown;
  invite?: { expiresInSeconds?: number; features?: { chat?: boolean; systemMessaging?: boolean } };
  inbox?: { intervalS?: number; lagS?: number; initialCursor?: number | null };
  scope?: { pollIntervalS?: number };
  reconcile?: { intervalS?: number };
  leaseTtlMs?: number;
  webhooks?: { enabled?: boolean; publicBaseUrl?: string | null };
  /** `service:apiEndpointHostPattern` (anchored at the end). Null rejects every accept. */
  apiEndpointHostPattern?: string | null;
  /** `service:patientAppBaseUrl`. */
  patientAppBaseUrl?: string | null;
  // ---- injection, mostly for tests ---- //
  /** A connection over a data grant. Default `new pryv.Connection(apiEndpoint)`. */
  connectionFor?: (apiEndpoint: string) => CmcConnection;
  /** Clock, ms. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Default `isSchedulerWorker()`. */
  isScheduler?: () => boolean;
}
