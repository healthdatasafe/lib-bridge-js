import boiler from 'dev-boiler';
import { bridgeConnection, streamIdForUserId, getUserParentStreamId, logErrorOnBridgeAccount } from '../lib/bridgeAccount.ts';
import * as pryvService from '../lib/pryvService.ts';
import { internalError, badRequest, serviceError } from '../errors/index.ts';
import type { AppError } from '../errors/index.ts';
import * as user from './user.ts';
import ShortUniqueId from 'short-unique-id';
import { advertiseNewUserToPlugins, requiredPermissionsAndStreams } from '../lib/plugins.ts';

const { getConfig, getLogger } = boiler;
let _logger: ReturnType<typeof getLogger> | null = null;
function logger () { return _logger || (_logger = getLogger('onboard')); }

const onboardingSecretGenerator = new ShortUniqueId({ dictionary: 'alphanum', length: 24 });

/**
 * Will be set by init with values from the config and service
 */
const settings: {
  requestingAppId: string | null;
  requestedPermissions: unknown[] | null;
  apiAccessURL: string | null;
  returnURL: string | null;
  consentMessage: string | null;
  partnerURLs: any;
  ensureBaseStreams?: unknown;
} = {
  requestingAppId: null,
  requestedPermissions: null,
  apiAccessURL: null,
  returnURL: null,
  consentMessage: null,
  partnerURLs: null
};

// from Pryv service
async function init (): Promise<void> {
  const config = await getConfig();
  settings.requestingAppId = config.get<string>('service:appId');
  settings.consentMessage = config.get<string>('service:consentMessage');
  // Accept both `baseURL` (lib convention) and `baseUrl` (bridge convention).
  const exposedUrl = config.get<string>('baseURL') ?? config.get<string>('baseUrl');
  settings.returnURL = exposedUrl + '/user/onboard/finalize/';

  settings.apiAccessURL = (await pryvService.service().info()).access;
  settings.partnerURLs = config.get('partnerURLs');

  // add permissions and streams from plugins
  const permissionsFromSettings = config.get<unknown[]>('service:userPermissionRequest');
  validatePermissions(permissionsFromSettings);
  const { permissions, streams } = requiredPermissionsAndStreams(permissionsFromSettings);
  settings.requestedPermissions = permissions as unknown[];
  settings.ensureBaseStreams = streams;
}

interface RedirectURLs {
  success: string;
  cancel: string;
}

interface InitiateResult {
  redirectURLs: RedirectURLs;
  webhookClientData: Record<string, unknown>;
  responseBody: any;
  onboardingSecret: string;
}

/**
 * Create an onboarding URL for this patient
 */
async function initiate (partnerUserId: string, redirectURLs: RedirectURLs, webhookClientData: Record<string, unknown>): Promise<unknown> {
  // check if user is active

  const userStatus = await user.status(partnerUserId, false);
  if (userStatus !== null) {
    return {
      type: 'userExists',
      user: userStatus.user
    };
  }
  // user found

  // create Auth Request
  const authRequestBody = {
    requestingAppId: settings.requestingAppId,
    requestedPermissions: settings.requestedPermissions,
    returnURL: settings.returnURL + partnerUserId, // add partneruserid to return URL
    clientData:
      {
        'app-web-auth:ensureBaseStreams': settings.ensureBaseStreams,
        'app-web-auth:description':
            {
              type: 'note/txt',
              content: settings.consentMessage
            }
      }
  };
  const response = await fetch(settings.apiAccessURL!, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(authRequestBody)
  });
  const responseBody = await response.json();

  const onboardingSecret = onboardingSecretGenerator.randomUUID();

  // -- store request intent
  const initiateResult: InitiateResult = { redirectURLs, webhookClientData, responseBody, onboardingSecret };
  await authStatusStore(partnerUserId, initiateResult);

  const result = {
    type: 'authRequest',
    onboardingSecret,
    // open-pryv.io 2.x renamed this field: POST /reg/access returns `authUrl`.
    redirectUserURL: (responseBody as any).authUrl,
    context: initiateResult
  };

  return result;
}

/**
 * Finalize an onboarding process
 */
async function finalize (partnerUserId: string, pollParam: string | string[]): Promise<string> {
  try {
    return await finalizeToBeCatched(partnerUserId, pollParam);
  } catch (e: any) {
    if (!e.skipWebHookCall) {
      const webhookParams: Record<string, unknown> = Object.assign(
        {
          type: 'ERROR',
          partnerUserId,
          error: e.message,
          errorObjectJSON: JSON.stringify(e.errorObject)
        }, e.webhookParams || { });
      // call webhook
      await webhookCall(settings.partnerURLs.webhookOnboard, webhookParams);
      logger().error(e);
    }
    const errorObject = {
      partnerUserId,
      pollParam,
      innerErrorMessage: e.message,
      innerErrorObject: e.errorObject || null
    };
    logErrorOnBridgeAccount('Failed finalizing onboarding', errorObject);
  }
  return getErrorRedirectURLWithMessage('Failed finalizing onboarding.');
}

/**
 * really finalized
 */
async function finalizeToBeCatched (partnerUserId: string, pollParam: string | string[]): Promise<string> {
  // might be an Array ..
  const pollURL = Array.isArray(pollParam) ? pollParam[0] : pollParam;
  if (pollURL == null || !pollURL.startsWith('http')) badRequest('Missing or invalid prYvpoll URL');
  const pollContent = await (await fetch(pollURL)).json() as any;

  // safety check that onboard process has started
  const currentAuthStatuses = await authStatusesGet(partnerUserId);
  const matchingStatuses = currentAuthStatuses.filter((s: any) => s.content.responseBody.poll === pollURL);
  if (matchingStatuses.length !== 1) {
    logger().error('No matching pending request for this user', { partnerUserId, pollParam });
    // -- redirect to partner error page
    return getErrorRedirectURLWithMessage('No matching pending request');
  }
  const matchingStatusContent = matchingStatuses[0].content;
  const webhookParams: Record<string, unknown> = Object.assign({ partnerUserId, onboardingSecret: matchingStatusContent.onboardingSecret }, matchingStatusContent.webhookClientData);

  // REMOVE pending request in background
  process.nextTick(() => { authStatusesClean(currentAuthStatuses); });

  // ACCEPTED
  try {
    if (pollContent.status === 'ACCEPTED') {
      // -- Add user credentials to partner streams
      await user.addCredentialToBridgeAccount(partnerUserId, pollContent.apiEndpoint);
      // -- Advertise plugins of this new user
      const pluginsResult = await advertiseNewUserToPlugins(partnerUserId, pollContent.apiEndpoint);
      webhookParams.pluginsResultJSON = JSON.stringify(pluginsResult);
      webhookParams.type = 'SUCCESS';
      // call webhook
      await webhookCall(settings.partnerURLs.webhookOnboard, webhookParams);
      return matchingStatusContent.redirectURLs.success;
    }

    // CANCELLED
    webhookParams.type = 'CANCEL';
    webhookParams.status = pollContent.status;
  } catch (e: any) {
    // just attach webhookParams to forward the error
    e.webhookParams = webhookParams;
    throw e;
  }
  await webhookCall(settings.partnerURLs.webhookOnboard, webhookParams);
  return matchingStatusContent.redirectURLs.cancel;
}

// ------ onboard steps

/**
 * Get pending auth status (may be sevrals)
 */
async function authStatusesGet (partnerUserId: string): Promise<any[]> {
  const userStreamId = streamIdForUserId(partnerUserId);
  const apiCalls = [{
    method: 'events.get',
    params: { streams: [userStreamId], types: ['temp-status/bridge-auth-request'] }
  }];
  const response = (await bridgeConnection().api(apiCalls as any) as any)[0];
  // -- todo check response
  return response.events || [];
}

async function authStatusStore (partnerUserId: string, payload: unknown): Promise<unknown> {
  const userStreamId = streamIdForUserId(partnerUserId);
  const apiCalls = [{
    method: 'streams.create',
    params: { id: userStreamId, parentId: getUserParentStreamId(), name: partnerUserId }
  }, {
    method: 'events.create',
    params: {
      type: 'temp-status/bridge-auth-request',
      streamIds: [userStreamId],
      content: payload
    }
  }];
  const response: any = await bridgeConnection().api(apiCalls as any);
  if (!response[1].event || response[1].error) serviceError('Failed storing auth status', response[1]);
  return response[1].event;
}

/**
 * Array of pending authStatus to remove
 */
async function authStatusesClean (authStatusEvents: any[]): Promise<void> {
  if (!authStatusEvents || authStatusEvents.length < 1) return;
  const apiCalls: any[] = [];
  for (const e of authStatusEvents) {
    const deleteCall = { method: 'events.delete', params: { id: e.id } };
    apiCalls.push(deleteCall, deleteCall); // twice for a real delete
  }
  const res: any = await bridgeConnection().api(apiCalls as any);
  for (const r of res) {
    if (r.error) logger().error('Failed deleting status event', r);
    if (r.eventDeletion) logger().info(`Deleted status event id: ${r.eventDeletion.id}`);
  }
}

// ------- helpers

/**
 * Validate if settings for requested permissions is valid
 */
function validatePermissions (permissions: any): void {
  if (!Array.isArray(permissions)) internalError('Permissions setting should be an array: ' + JSON.stringify(permissions, null, 2));
  if (permissions.length === 0) internalError('Permissions setting should have one element ' + JSON.stringify(permissions, null, 2));
  for (const p of permissions) {
    if (p.streamId === '*' && p.level === 'manage' && p.defaultName === undefined) continue;
    for (const k of ['streamId', 'level', 'defaultName']) {
      if (!p[k] || typeof p[k] !== 'string') internalError('Permissions setting is not valid ' + JSON.stringify(p, null, 2));
    }
  }
}

// --- webhook caller
async function webhookCall (whSettings: any, params: Record<string, unknown>): Promise<void> {
  // Call partner webhook
  const fetchParams: RequestInit = {
    method: whSettings.method,
    headers: { ...whSettings.headers }
  };
  let queryParams = '';
  if (whSettings.method === 'GET') {
    if (Object.keys(params).length > 0) queryParams = '?' + new URLSearchParams(params as Record<string, string>);
  } else { // assume POST
    (fetchParams.headers as Record<string, string>)['Content-Type'] = 'application/json';
    fetchParams.body = JSON.stringify(params);
  }
  try {
    await fetch(whSettings.url + queryParams, fetchParams);
  } catch (e) {
    logger().error('Failed contacting partner backend', e);
    const e2: AppError = new Error('Failed contacting partner backend');
    e2.errorObject = {
      webhookCall: {
        whSettings,
        params
      }
    };
    e2.skipWebHookCall = true;
    e2.webhookParams = params;
    throw e2;
  }
}

function getErrorRedirectURLWithMessage (message: string): string {
  const encodedMessage = encodeURIComponent(message);
  return settings.partnerURLs.defaultRedirectOnError + '?message=' + encodedMessage;
}

export { init, initiate, finalize, authStatusesGet, authStatusesClean };
