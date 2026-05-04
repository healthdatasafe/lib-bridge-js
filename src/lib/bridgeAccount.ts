/**
 * Manage the bridge connection and interaction
 */
import boiler from '@pryv/boiler';
import { pryv } from 'hds-lib';
import { internalError, serviceError } from '../errors/index.ts';

const { getConfig, getLogger } = boiler;
let _logger: ReturnType<typeof getLogger> | null = null;
function logger () { return _logger || (_logger = getLogger('bridgeAccount')); }

const { Connection } = pryv;

/** the connection to pryv bridge account */
let _bridgeConnection: InstanceType<typeof Connection> | null = null;

/** Will prefix all users' streamsId  */
const PARENT_USER_STREAM_SUFFIX = '-users';

const settings: {
  mainStreamId: string | null;
  userParentStreamId: string | null;
  activeUsersStreamId: string | null;
  errorStreamId: string | null;
} = {
  mainStreamId: null,
  userParentStreamId: null,
  activeUsersStreamId: null,
  errorStreamId: null
};

/**
 * get the active bridge connection
 */
function bridgeConnection (): InstanceType<typeof Connection> {
  if (!_bridgeConnection) throw new Error('Init bridgeAccount first');
  return _bridgeConnection;
}

/**
 * Init the bridgeAccount
 */
async function init (): Promise<void> {
  if (_bridgeConnection) return;
  const config = await getConfig();
  const bridgeApiEndPoint = config.get<string>('bridgeApiEndPoint');
  _bridgeConnection = new Connection(bridgeApiEndPoint);
  settings.mainStreamId = config.get<string>('service:bridgeAccountMainStreamId');
  settings.userParentStreamId = settings.mainStreamId + PARENT_USER_STREAM_SUFFIX;
  settings.activeUsersStreamId = settings.userParentStreamId + '-active';
  settings.errorStreamId = settings.mainStreamId + '-errors';
  // check that access has "manage" on the bridge's main stream — Pryv may
  // inject other permissions (e.g. ":_system:account") at arbitrary indices,
  // so search the list rather than relying on permissions[0].
  const info = await _bridgeConnection.accessInfo();
  const hasManage = info?.permissions?.some(
    (p: { streamId?: string, level?: string }) =>
      p.streamId === settings.mainStreamId && p.level === 'manage'
  );
  if (!hasManage) {
    internalError(`Bridge does not have "manage" permissions on stream ${settings.mainStreamId}`, info);
  }
  await ensureBaseStreams();
}

/**
 * Util to get the streamId of active users
 */
function getActiveUserStreamId (): string {
  return settings.activeUsersStreamId!;
}

/**
 * Util to get the user parent streamId
 */
function getUserParentStreamId (): string {
  return settings.userParentStreamId!;
}

/**
 * Util to get the streamId of a partnerUserId
 */
function streamIdForUserId (partnerUserId: string): string {
  // if partnerUserId is not streamId compliant .. make it lowercase and alpha only.
  return settings.userParentStreamId + '-' + partnerUserId;
}

/**
 * Ensure base structure is created
 */
async function ensureBaseStreams (): Promise<void> {
  const apiCalls = [{
    method: 'streams.create',
    params: { parentId: settings.mainStreamId, id: settings.userParentStreamId, name: 'Bridge Users' }
  }, {
    method: 'streams.create',
    params: { parentId: settings.mainStreamId, id: settings.activeUsersStreamId, name: 'Active Bridge Users' }
  }, {
    method: 'streams.create',
    params: { parentId: settings.mainStreamId, id: settings.errorStreamId, name: 'Bridge Errors' }
  }];
  const res: any = await _bridgeConnection!.api(apiCalls as any);
  const unexpectedErrors = res.filter((r: any) => r.error && r.error.id !== 'item-already-exists');
  if (unexpectedErrors.length > 0) {
    serviceError('Failed creating base streams', unexpectedErrors);
  }
}

/**
 * Log error to the bridge account
 */
async function logErrorOnBridgeAccount (message: string, errorObject: unknown = {}): Promise<unknown> {
  const params = {
    type: 'error/message-object',
    streamIds: [settings.errorStreamId],
    content: {
      message,
      errorObject
    }
  };
  return await createSingleEvent(params, 'logging error');
}

/**
 * Log a successfull synchronization
 */
async function logSyncStatus (partnerUserId: string, time: number | null = null, content: unknown = null): Promise<unknown> {
  const userStreamId = streamIdForUserId(partnerUserId);
  const params: Record<string, unknown> = {
    type: 'sync-status/bridge',
    streamIds: [userStreamId],
    content
  };
  if (time != null) params.time = time;
  return await createSingleEvent(params, 'creating log status');
}

/**
 * Retreive errors on the bridge account
 */
async function getErrorsOnBridgeAccount (parameters: Record<string, unknown> = {}): Promise<unknown> {
  const params = Object.assign({
    streams: [settings.errorStreamId],
    types: ['error/message-object']
  }, parameters);
  const res: any = await _bridgeConnection!.api([{
    method: 'events.get',
    params
  }] as any);
  if (res.error || !res[0]?.events) {
    return res;
  }
  return res[0].events;
}

/**
 * Helper - create a single event, returns it's content of an error
 */
async function createSingleEvent (params: Record<string, unknown>, messageOnError = 'creating event'): Promise<unknown> {
  const apiCalls = [{
    method: 'events.create',
    params
  }];
  try {
    const res: any = await _bridgeConnection!.api(apiCalls as any);
    if (res[0].error || !res[0].event) {
      logger().error(`Failed ${messageOnError} on bridge account result:`, res);
      return res;
    }
    return res[0]?.event;
  } catch (e) {
    logger().error(`Failed  ${messageOnError} on bridge account error:`, e);
    return e;
  }
}

export {
  init,
  bridgeConnection,
  streamIdForUserId,
  getUserParentStreamId,
  getActiveUserStreamId,
  logErrorOnBridgeAccount,
  getErrorsOnBridgeAccount,
  logSyncStatus
};
