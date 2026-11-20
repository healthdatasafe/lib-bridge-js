/**
 * Is a data grant still live? Lifted from bridge-mira's `revokedGrant.ts` (plan 129).
 *
 * Only an explicit answer from the core counts as gone: `invalid-access-token` (revoked or
 * deleted) or `forbidden` (expired) on access-info. A network failure or any other error is
 * `unknown`, so a transient outage never tears a relationship down.
 */

interface ApiConnection { api: (calls: any[]) => Promise<any> }

export type GrantState = 'live' | 'gone' | 'unknown';

/** Error ids on access-info that mean the grant no longer exists. */
const GONE_IDS: readonly string[] = ['invalid-access-token', 'forbidden'];

const NOT_AN_ARRAY = 'API call result is not an Array: ';

/**
 * The core's error id when it refused the request, whichever way lib-js reports it: a per-call
 * error result, a PryvError carrying the body (`innerObject` / `response.body`), a PryvError
 * carrying the call's error itself (`innerObject = { id, message }`, pryv 3.19 `accessInfo()`),
 * or (pryv <= 3.13) the body as JSON in the message.
 */
export function refusalId (e: unknown): string | null {
  const err = e as { innerObject?: { id?: unknown, error?: { id?: unknown } }, id?: unknown, response?: { body?: { error?: { id?: unknown } } }, message?: unknown };
  const id = [err?.innerObject?.error?.id, err?.innerObject?.id, err?.response?.body?.error?.id, err?.id].find((v) => typeof v === 'string');
  if (typeof id === 'string') return id;
  if (typeof err?.message === 'string' && err.message.startsWith(NOT_AN_ARRAY)) {
    try {
      const body = JSON.parse(err.message.slice(NOT_AN_ARRAY.length));
      if (typeof body?.error?.id === 'string') return body.error.id;
    } catch { /* not JSON */ }
  }
  return null;
}

/** `live`, `gone` (the core says the grant no longer exists) or `unknown` (could not tell). */
export async function grantState (connection: ApiConnection): Promise<GrantState> {
  return (await readAccessInfo(connection)).state;
}

/** `grantState`, with the access-info itself when live. */
export async function readAccessInfo (connection: ApiConnection): Promise<{ state: 'live', info: any } | { state: 'gone' | 'unknown' }> {
  let id: string | null;
  try {
    const res = await connection.api([{ method: 'getAccessInfo', params: {} }]);
    const error = res?.[0]?.error;
    if (error == null) return { state: 'live', info: res?.[0] ?? {} };
    id = typeof error.id === 'string' ? error.id : null;
  } catch (e) {
    id = refusalId(e);
  }
  return { state: id != null && GONE_IDS.includes(id) ? 'gone' : 'unknown' };
}
