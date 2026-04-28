/**
 * App-stream creation helper (Plan 25 / Plan 45 Phase 9).
 *
 * Bridges declare a `{app-id}-app/` subtree on each user account to expose
 * app-specific content (notes, system messages, ...) using a stable,
 * non-canonical naming convention. This helper provisions the tree
 * idempotently and returns the `appStreamId` to attach on the bridge's access
 * `clientData.appStreamId` field — that's the load-bearing pointer (the stream
 * name itself is non-load-bearing per Plan 45's "stream-naming convention is
 * soft" principle).
 *
 * Example — bridge-mira:
 *   await ensureAppStreamsTree(hdsConnection, {
 *     appId: 'bridge-mira',
 *     baseName: 'Mira App',
 *     parentId: 'bridge-mira',  // child of the existing base stream
 *     subStreams: [
 *       { suffix: 'notes', name: 'Notes' }
 *     ]
 *   });
 *   // → ensures `bridge-mira-app` + `bridge-mira-app-notes`
 */

import type { Connection } from 'pryv';

export interface AppStreamSubstream {
  /** Suffix appended to `{appId}-app-` (e.g. `'notes'` → `bridge-mira-app-notes`). */
  suffix: string;
  /** Display name for the substream. */
  name: string;
  /** Optional `clientData` block carried onto the substream (e.g. `hdsCustomField`, `hdsSystemFeature`). */
  clientData?: Record<string, unknown>;
}

export interface EnsureAppStreamsOptions {
  /** Bridge / app id (e.g. `'bridge-mira'`). The app-stream root is `${appId}-app`. */
  appId: string;
  /** Display name for `${appId}-app`. Default: `${appId} App`. */
  baseName?: string;
  /** Optional parent stream id for `${appId}-app` (e.g. an existing `${appId}` base). */
  parentId?: string | null;
  /** Substreams to provision under `${appId}-app`. */
  subStreams?: AppStreamSubstream[];
}

export interface EnsureAppStreamsResult {
  /** The provisioned app-stream root id — `${appId}-app`. Use as `clientData.appStreamId` on accesses. */
  appStreamId: string;
  /** Map of substream suffix → full streamId. */
  subStreamIds: Record<string, string>;
}

interface StreamCreateResult {
  stream?: { id: string, name: string };
  error?: { id: string };
}

/**
 * Ensure a `{appId}-app/` stream tree exists on the connection's account.
 * Idempotent — tolerates `item-already-exists`.
 *
 * Returns the resolved ids so callers can:
 *   - attach `clientData.appStreamId` on the bridge access (see `appTemplates.ensureBridgeAccess`),
 *   - and post events to specific substreams.
 */
export async function ensureAppStreamsTree (
  connection: Connection,
  opts: EnsureAppStreamsOptions
): Promise<EnsureAppStreamsResult> {
  if (!opts.appId || typeof opts.appId !== 'string') {
    throw new Error('ensureAppStreamsTree: appId must be a non-empty string');
  }
  const appStreamId = `${opts.appId}-app`;
  const subStreamIds: Record<string, string> = {};

  const apiCalls: Array<{ method: 'streams.create', params: any }> = [
    {
      method: 'streams.create',
      params: {
        id: appStreamId,
        name: opts.baseName ?? `${opts.appId} App`,
        ...(opts.parentId != null ? { parentId: opts.parentId } : {})
      }
    }
  ];

  for (const sub of opts.subStreams ?? []) {
    if (!sub.suffix || typeof sub.suffix !== 'string') {
      throw new Error('ensureAppStreamsTree: substream.suffix must be a non-empty string');
    }
    const fullId = `${appStreamId}-${sub.suffix}`;
    subStreamIds[sub.suffix] = fullId;
    apiCalls.push({
      method: 'streams.create',
      params: {
        id: fullId,
        parentId: appStreamId,
        name: sub.name,
        ...(sub.clientData != null ? { clientData: sub.clientData } : {})
      }
    });
  }

  const results = (await connection.api(apiCalls as any)) as StreamCreateResult[];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r?.stream?.id) continue;
    if (r?.error?.id === 'item-already-exists') continue;
    throw new Error(
      `ensureAppStreamsTree: failed to create stream "${apiCalls[i].params.id}" — ${r?.error?.id ?? 'unknown error'}`
    );
  }

  return { appStreamId, subStreamIds };
}
