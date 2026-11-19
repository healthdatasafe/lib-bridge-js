import { bridgeConnection, streamIdForUserId, getUserParentStreamId, getActiveUserStreamId, getSyncStatus } from '../lib/bridgeAccount.ts';
import { unkownRessource, serviceError, badRequest } from '../errors/index.ts';
import { pryv } from 'hds-lib';

interface UserInfo {
  active: boolean;
  partnerUserId: string;
  apiEndpoint: string;
  created: number;
  modified: number;
}

interface SyncStatusInfo {
  content: unknown;
  lastSync: number | undefined;
}

interface UserStatus {
  user: UserInfo;
  syncStatus: SyncStatusInfo;
}

interface StatusAndPryvConnection extends UserStatus {
  connection: InstanceType<typeof pryv.Connection>;
}

const CREDENTIAL_TYPE = 'credentials/pryv-api-endpoint';

/**
 * Add (or refresh) a user's data-grant credential on the bridge account.
 *
 * **Idempotent by identity, not just by content.** Callers rely on this: the CMC inbox
 * watcher re-processes recent accept events after every restart, and runs independently in
 * each cluster worker, so the same accept legitimately reaches here several times.
 *
 * This used to be an unconditional `events.create`, which meant every one of those calls
 * appended another credential event. On prod 2026-08-28 a single accept produced a new
 * event every 30s per worker — 10 duplicates within minutes, growing without bound — while
 * this function's own docstring claimed it "overwrites the credential event". Reads use
 * `limit: 1` so nothing broke visibly; the account just grew forever. It is also the most
 * likely origin of the duplicate records previously noticed on the old prod account.
 *
 * Now: reuse the existing credential event when there is one, updating it in place (and
 * re-asserting the active-users stream, so a previously deactivated user is reactivated
 * rather than duplicated). Only create when none exists.
 *
 * `opts.clientData` is set on create and merged (top-level keys) onto the stored clientData on
 * update, e.g. the CMC relationship record under `hdsCmc`. Without it clientData is untouched.
 */
async function addCredentialToBridgeAccount (
  partnerUserId: string,
  appApiEndpoint: string,
  opts: { clientData?: Record<string, unknown> } = {}
): Promise<unknown> {
  const streamUserId = streamIdForUserId(partnerUserId);
  const streamIds = [streamUserId, getActiveUserStreamId()];

  // Ensure the per-user stream exists, and look for a credential already stored there.
  const pre: any = await bridgeConnection().api([{
    method: 'streams.create',
    params: { id: streamUserId, parentId: getUserParentStreamId(), name: partnerUserId }
  }, {
    method: 'events.get',
    params: { streams: [streamUserId], types: [CREDENTIAL_TYPE], limit: 1 }
  }] as any);

  const existing = pre[1]?.events?.[0];
  if (existing?.id != null) {
    const update: Record<string, unknown> = { content: appApiEndpoint, streamIds };
    if (opts.clientData != null) update.clientData = { ...(existing.clientData ?? {}), ...opts.clientData };
    const updated: any = await bridgeConnection().api([{
      method: 'events.update',
      params: { id: existing.id, update }
    }] as any);
    if (updated[0]?.error?.id != null) throw serviceError('Failed add user credentials', updated[0]);
    return updated[0];
  }

  const params: Record<string, unknown> = { streamIds, type: CREDENTIAL_TYPE, content: appApiEndpoint };
  if (opts.clientData != null) params.clientData = opts.clientData;
  const created: any = await bridgeConnection().api([{
    method: 'events.create',
    params
  }] as any);
  if (created[0]?.error?.id != null) throw serviceError('Failed add user credentials', created[0]);
  return created[0];
}

export interface CredentialEvent {
  id: string;
  apiEndpoint: string;
  clientData: Record<string, unknown>;
}

/** Every credential event of the user, newest first; null when the user stream does not exist. */
async function credentialEvents (partnerUserId: string): Promise<any[] | null> {
  const res: any = await bridgeConnection().api([{
    method: 'events.get',
    params: { streams: [streamIdForUserId(partnerUserId)], types: [CREDENTIAL_TYPE], state: 'all', limit: 1000 }
  }] as any);
  if (res[0]?.error?.id === 'unknown-referenced-resource') return null;
  if (res[0]?.error != null) serviceError('Failed to read user credentials', { id: res[0].error.id });
  return res[0]?.events ?? [];
}

/**
 * The user's current (newest, non-trashed) credential event: its id, the stored apiEndpoint
 * and its clientData (`{}` when none). Null when the user has none.
 */
async function getCredentialEvent (partnerUserId: string): Promise<CredentialEvent | null> {
  const res: any = await bridgeConnection().api([{
    method: 'events.get',
    params: { streams: [streamIdForUserId(partnerUserId)], types: [CREDENTIAL_TYPE], limit: 1 }
  }] as any);
  if (res[0]?.error?.id === 'unknown-referenced-resource') return null;
  if (res[0]?.error != null) serviceError('Failed to read user credentials', { id: res[0].error.id });
  const event = res[0]?.events?.[0];
  if (event == null) return null;
  return { id: event.id, apiEndpoint: event.content, clientData: event.clientData ?? {} };
}

/**
 * Delete (trash, then delete for good) every credential event of the user, which also takes the
 * user out of the active-users stream. `onlyIfClientData` guards it on the CURRENT credential's
 * clientData (e.g. a CMC generation check): when it returns false nothing is deleted.
 * Returns `deleted`, `none` (no credential stored) or `refused` (the guard said no).
 */
async function deleteCredentialFromBridgeAccount (
  partnerUserId: string,
  opts: { onlyIfClientData?: (clientData: Record<string, unknown>) => boolean } = {}
): Promise<'deleted' | 'none' | 'refused'> {
  const events = await credentialEvents(partnerUserId);
  if (events == null || events.length === 0) return 'none';
  if (opts.onlyIfClientData != null) {
    const current = events.find(e => e.trashed !== true);
    if (current == null || !opts.onlyIfClientData(current.clientData ?? {})) return 'refused';
  }
  const calls: any[] = [];
  for (const e of events) {
    if (e.trashed !== true) calls.push({ method: 'events.delete', params: { id: e.id } });
    calls.push({ method: 'events.delete', params: { id: e.id } });
  }
  const res: any = await bridgeConnection().api(calls as any);
  const failed = (res as any[]).find(r => r?.error != null && r.error.id !== 'unknown-resource');
  if (failed != null) serviceError('Failed to delete user credentials', { id: failed.error.id });
  return 'deleted';
}

async function exists (partnerUserId: string): Promise<boolean> {
  const streamUserId = streamIdForUserId(partnerUserId);
  const apiCalls = [{
    method: 'events.get',
    params: { streams: [streamUserId], limit: 1, types: ['credentials/pryv-api-endpoint'] }
  }];
  const result: any = await bridgeConnection().api(apiCalls as any);
  if (result[0]?.error?.id === 'unknown-referenced-resource') return false;
  return true;
}

/**
 * Get user status
 */
async function status (partnerUserId: string, throwUnkown = true): Promise<UserStatus | null> {
  const streamUserId = streamIdForUserId(partnerUserId);
  const apiCalls = [{
    method: 'events.get',
    params: { streams: [streamUserId], limit: 1, types: ['credentials/pryv-api-endpoint'] }
  }];
  const resultFromBC: any = await bridgeConnection().api(apiCalls as any);
  if (resultFromBC[0]?.error?.id === 'unknown-referenced-resource') {
    if (throwUnkown) {
      unkownRessource('Unkown user', { userId: partnerUserId });
    }
    return null;
  }
  const error = resultFromBC.error || resultFromBC[0]?.error;
  if (error) serviceError('Failed to get user status', error);
  const userEvent = resultFromBC[0].events[0];
  if (userEvent == null) {
    if (throwUnkown) {
      unkownRessource('Unkown user', { userId: partnerUserId });
    }
    return null;
  }
  const syncEvent = await getSyncStatus(partnerUserId);
  // Bridges keeping `lastSyncedAt` (ms, null = never synced) update the event in place, so its
  // time is the first write, not the last sync. Use the event time only when the key is absent.
  // Pryv times are seconds.
  const content = syncEvent?.content;
  let lastSync = syncEvent?.time;
  if (content != null && 'lastSyncedAt' in content) {
    lastSync = typeof content.lastSyncedAt === 'number' ? content.lastSyncedAt / 1000 : undefined;
  }
  const result: UserStatus = {
    user: {
      active: userEvent.streamIds.includes(getActiveUserStreamId()),
      partnerUserId,
      apiEndpoint: userEvent.content,
      created: userEvent.created,
      modified: userEvent.modified
    },
    syncStatus: {
      content: syncEvent?.content,
      lastSync
    }
  };
  return result;
}

async function setStatus (partnerUserId: string, active?: boolean): Promise<{ active: boolean }> {
  const streamUserId = streamIdForUserId(partnerUserId);
  const apiCalls = [{
    method: 'events.get',
    params: { streams: [streamUserId], limit: 1, types: ['credentials/pryv-api-endpoint'] }
  }];
  const resultFromBC: any = await bridgeConnection().api(apiCalls as any);
  if (resultFromBC[0]?.error?.id === 'unknown-referenced-resource') unkownRessource('Unkown user', { userId: partnerUserId });
  const error = resultFromBC.error || resultFromBC[0]?.error;
  if (error) serviceError('Failed to get user status', error);
  const userEvent = resultFromBC[0].events[0];
  const currentStatus = userEvent.streamIds.includes(getActiveUserStreamId());
  if (currentStatus === active) return { active: currentStatus };

  // change streams
  const newStreamIds = [...userEvent.streamIds];
  if (active) {
    newStreamIds.push(getActiveUserStreamId());
  } else {
    const index = newStreamIds.indexOf(getActiveUserStreamId());
    if (index > -1) newStreamIds.splice(index, 1);
  }
  const apiCallsUpdate = [{
    method: 'events.update',
    params: {
      id: userEvent.id,
      update: {
        streamIds: newStreamIds
      }
    }
  }];
  const resultUpdate: any = await bridgeConnection().api(apiCallsUpdate as any);
  if (resultUpdate[0]?.error?.id === 'unknown-referenced-resource') unkownRessource('Unkown user', { userId: partnerUserId });
  const errorUpdate = resultUpdate.error || resultUpdate[0]?.error;
  if (errorUpdate) serviceError('Failed to get user status', errorUpdate);
  const newActiveStatus = resultUpdate[0].event.streamIds.includes(getActiveUserStreamId());
  return { active: newActiveStatus };
}

/**
 * Pryv API endpoint and status for the user
 */
async function getPryvConnectionAndStatus (partnerUserId: string, includesInactive = false): Promise<StatusAndPryvConnection> {
  const statusResult = await status(partnerUserId);
  if (!statusResult!.user.active && !includesInactive) {
    badRequest('Deactivated User', { userId: partnerUserId });
  }
  const connection = new pryv.Connection(statusResult!.user.apiEndpoint);
  return {
    ...statusResult!,
    connection
  };
}

/**
 * Get all users and their status
 */
async function getAllUsersApiEndpoints (forEachEvent: (event: unknown) => void): Promise<unknown> {
  const now = (new Date()).getTime() / 1000;
  const queryParams = { fromTime: 0, toTime: now, streams: [getUserParentStreamId()], types: ['credentials/pryv-api-endpoint'] };
  return await bridgeConnection().getEventsStreamed(queryParams, forEachEvent);
}

export {
  status,
  exists,
  addCredentialToBridgeAccount,
  getCredentialEvent,
  deleteCredentialFromBridgeAccount,
  getPryvConnectionAndStatus,
  setStatus,
  getAllUsersApiEndpoints
};
