// lib-bridge-js public API
export { default as PluginBridge } from './lib/PluginBridge.ts';
export { createBridgeApp, launch } from './server.ts';
export { default as startCluster } from './start.ts';
export { default as initBoiler } from './initBoiler.ts';
export * as errors from './errors/index.ts';

// Observability primitives (plan 88) — the single fence-4-compliant implementation
// (route-pattern allow-list, unmatched-drop). Exported so standalone Express services
// that do NOT boot through createBridgeApp (e.g. datasets-service, bridge-athenahealth)
// can install the same timing middleware + emitter instead of copying the logic.
export {
  observabilityTiming,
  initBridgeObservability,
  bridgeTelemetry,
  CMC_METHOD_IDS,
  CMC_ERROR_CODES
} from './lib/observability.ts';
export type { ObsHolder, ObservabilityExtras, CmcMethodId, CmcErrorCode } from './lib/observability.ts';

// Crash-loop detection, for standalone services that run their own cluster primary
// (startCluster is bound to createBridgeApp and a bridge account), e.g. hds-support-service.
export { createCrashLoopMonitor, CRASH_LOOP_DEFAULTS } from './lib/crashLoopMonitor.ts';

// Re-export essentials for consumers
export { initHDSModel, getHDSModel, pryv } from 'hds-lib';
export { default as Router } from 'express-promise-router';
export { default as ShortUniqueId } from 'short-unique-id';

// Utilities needed by consumers (testing, setup)
export { requiredPermissionsAndStreams } from './lib/plugins.ts';
export { init as initPryvService, createuser as createPryvUser } from './lib/pryvService.ts';
export { addCredentialToBridgeAccount, deleteCredentialFromBridgeAccount, getCredentialEvent } from './methods/user.ts';
export type { CredentialEvent } from './methods/user.ts';

// Bridge-account stream ids for the CMC relationship module (plan 129)
export { getCmcStreamId, isValidCmcUserKey, PRYV_STREAM_ID_MAX_LENGTH } from './lib/bridgeAccount.ts';

// CMC relationship module for collector-side bridges (plan 129)
export { createCmcRelationships, CmcRelationshipError } from './cmc/index.ts';
export type {
  CmcRelationships, CmcRelationship, CmcRelationshipRecord, CmcHooks, CmcRelationshipsOptions, CmcScopeHealth,
  CreateInviteParams, CreateInviteResult, PendingScopeRequest, ScopeOptions, ScopeAnswer, ChangeContext, EndReason,
  SystemAlert, WebhookScopes, CmcConversation
} from './cmc/index.ts';
// The standard conversation (data-model 4.22.0), the contact's side bound to one relationship (also `rel.conversation`)
export { bindConversation } from './cmc/conversation.ts';
export type { ConversationBinding } from './cmc/conversation.ts';

// Is a data grant still live? (`gone` only on an explicit refusal from the core)
export { grantState, readAccessInfo, refusalId } from './lib/grantState.ts';
export type { GrantState } from './lib/grantState.ts';

// Logger (re-exported from dev-boiler to avoid duplicate singleton issues)
export { getLogger } from './lib/PluginBridge.ts';

// Shared cache (cluster-safe via memored)
export { cacheGet, cacheSet, cacheDel, cacheTake, cacheLock, cacheRenew, cacheUnlock, initCacheLocal } from './lib/cache.ts';

// Durable per-user sync state, one `sync-status/bridge` event per user (plan 101 T7)
export { SyncStateStore, SYNC_STATUS_TYPE } from './lib/syncState.ts';
export type { SyncStateStoreOptions } from './lib/syncState.ts';

// Connector status in the USER's account, one `sync-status/connector-v1` event per
// `sync-status-<connector>` leaf (data-model 3.13.0), plus the return-URL allow-list helpers
// used after a partner OAuth.
export {
  CONNECTOR_STATUS_TYPE,
  CONNECTOR_ERROR_CODE_PATTERN,
  ConnectorStatusApiError,
  nowSeconds,
  sanitizeConnectorStatus,
  nextConnectorStatus,
  readConnectorStatus,
  publishConnectorStatus,
  recordConnectorOutcome,
  isConnectorStatusAccessError,
  normalizeAllowedOrigins,
  isAllowedReturnUrl,
  buildRedirectUrl
} from './lib/connectorStatus.ts';
export type {
  ConnectorStatusContent,
  ConnectorStatusValue,
  ConnectorStatusError,
  ConnectorErrorClass,
  ConnectorOutcome,
  PublishConnectorStatusResult
} from './lib/connectorStatus.ts';

// Scheduler role: exactly one live cluster worker runs periodic jobs, handed to the
// replacement when it dies. Workers call `isSchedulerWorker()`.
export { isSchedulerWorker, createSchedulerRole, SCHEDULER_ENV } from './lib/schedulerRole.ts';
export type { SchedulerRole } from './lib/schedulerRole.ts';

// App-streams helper (Plan 25 / Plan 45 Phase 9)
export { ensureAppStreamsTree } from './lib/appStreams.ts';
export type {
  AppStreamSubstream,
  EnsureAppStreamsOptions,
  EnsureAppStreamsResult
} from './lib/appStreams.ts';

// Test helpers — available via 'lib-bridge-js/test' (separate entry to avoid loading test deps in production)
// import * as testServer from 'lib-bridge-js/test';
