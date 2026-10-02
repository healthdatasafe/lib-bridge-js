/**
 * Connector status in the USER's account: one `sync-status/connector-v1` event on the
 * connector's leaf stream (`sync-status-<connector>`), updated in place (data-model 3.13.0,
 * `documentation/SYNC-STATUS.md`). Apps the user authorised read it to show "Mira: connected,
 * last synced this morning" without calling the bridge.
 *
 * Not to be confused with `SyncStateStore` (./syncState.ts), the bridge's private resume
 * watermark on its OWN account. That one is free-form; this one is a closed schema read by
 * other apps, so it carries only the fields below and never partner text.
 *
 * Rules the writer follows (SYNC-STATUS.md):
 * - all times are Unix SECONDS;
 * - the whole content is sent on every update (`events.update` replaces `content`);
 * - a fresh connect starts a new content: new `connectedAt`, no `lastError`;
 * - `lastError.code` matches `^[a-z0-9][a-z0-9-]{0,63}$`, an operator code.
 *
 * Also holds the return-URL helpers used after a partner OAuth to send the user back to the
 * HDS app that started the connect (exact-origin allow-list).
 */

export const CONNECTOR_STATUS_TYPE = 'sync-status/connector-v1';

export type ConnectorStatusValue = 'active' | 'needs-reauth' | 'error' | 'disconnected';
export type ConnectorErrorClass = 'auth' | 'upstream' | 'hds' | 'other';

export interface ConnectorStatusError {
  class: ConnectorErrorClass;
  code?: string;
  /** Unix seconds. */
  at: number;
}

export interface ConnectorStatusContent {
  status: ConnectorStatusValue;
  connectedAt?: number;
  lastRunAt?: number;
  lastSuccessAt?: number;
  syncedUntil?: number;
  lastError?: ConnectorStatusError;
}

/** What just happened, as input to `nextConnectorStatus`. */
export type ConnectorOutcome =
  /** The user granted the connector access. `at` (Unix seconds) defaults to now. */
  | { kind: 'connected', at?: number }
  /** A sync run succeeded. `syncedUntil` only when the connector knows a real high-water mark. */
  | { kind: 'success', syncedUntil?: number }
  /** The partner credential is dead; the user must reconnect. */
  | { kind: 'reauth', code?: string }
  /** A sync run failed for another reason. */
  | { kind: 'failure', errorClass: ConnectorErrorClass, code?: string }
  /** The user disconnected the service. */
  | { kind: 'disconnected' };

export const CONNECTOR_ERROR_CODE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

const STATUS_VALUES: readonly string[] = ['active', 'needs-reauth', 'error', 'disconnected'];
const ERROR_CLASSES: readonly string[] = ['auth', 'upstream', 'hds', 'other'];

/** Current time in Unix seconds (integer). */
export function nowSeconds (): number {
  return Math.floor(Date.now() / 1000);
}

function num (v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function cleanError (e: unknown): ConnectorStatusError | undefined {
  if (e == null || typeof e !== 'object') return undefined;
  const o = e as Record<string, unknown>;
  const at = num(o.at);
  if (typeof o.class !== 'string' || !ERROR_CLASSES.includes(o.class) || at == null) return undefined;
  const out: ConnectorStatusError = { class: o.class as ConnectorErrorClass, at };
  if (typeof o.code === 'string' && CONNECTOR_ERROR_CODE_PATTERN.test(o.code)) out.code = o.code;
  return out;
}

/**
 * Keep only the schema's fields from a stored content (the schema is closed: a stray field
 * would make the next write fail validation). Returns null when it is not a status at all.
 */
export function sanitizeConnectorStatus (content: unknown): ConnectorStatusContent | null {
  if (content == null || typeof content !== 'object') return null;
  const o = content as Record<string, unknown>;
  if (typeof o.status !== 'string' || !STATUS_VALUES.includes(o.status)) return null;
  const out: ConnectorStatusContent = { status: o.status as ConnectorStatusValue };
  for (const k of ['connectedAt', 'lastRunAt', 'lastSuccessAt', 'syncedUntil'] as const) {
    const v = num(o[k]);
    if (v != null) out[k] = v;
  }
  const lastError = cleanError(o.lastError);
  if (lastError != null) out.lastError = lastError;
  return out;
}

function makeError (errorClass: ConnectorErrorClass, code: string | undefined, at: number): ConnectorStatusError {
  const e: ConnectorStatusError = { class: errorClass, at };
  // Never let a malformed code fail the write: drop it, the class still says enough.
  if (code != null && CONNECTOR_ERROR_CODE_PATTERN.test(code)) e.code = code;
  return e;
}

/**
 * Pure: the next whole content from the previous one (or null) and an outcome.
 *
 * - `connected`: `active`, `connectedAt` = the connect time, no `lastError`; `lastRunAt`,
 *   `lastSuccessAt`, `syncedUntil` are kept (they are still true of the data already imported).
 *   A connect not newer than the stored `connectedAt` is a replay (e.g. an inbox re-read after
 *   a restart) and returns the previous content unchanged, so it cannot revive a
 *   `disconnected` or clear a `needs-reauth`.
 * - `success`: `active`, `lastRunAt` = `lastSuccessAt` = now; `syncedUntil` from the outcome
 *   or carried; `lastError` carried (an `active` with an older `lastError` is a recovered failure).
 * - `reauth`: `needs-reauth`, `lastError {class: auth}`.
 * - `failure`: `error`, `lastError {class, code}` (`auth` class → `needs-reauth`).
 * - `disconnected`: `disconnected`, everything else carried.
 *
 * `connectedAt`, `lastSuccessAt`, `syncedUntil` are carried forward on every run outcome;
 * `lastRunAt` is set on every run outcome.
 */
export function nextConnectorStatus (
  previous: ConnectorStatusContent | null | undefined,
  outcome: ConnectorOutcome,
  now: number = nowSeconds()
): ConnectorStatusContent {
  const prev = sanitizeConnectorStatus(previous);
  const carried: Omit<ConnectorStatusContent, 'status'> = {};
  if (prev?.connectedAt != null) carried.connectedAt = prev.connectedAt;
  if (prev?.lastRunAt != null) carried.lastRunAt = prev.lastRunAt;
  if (prev?.lastSuccessAt != null) carried.lastSuccessAt = prev.lastSuccessAt;
  if (prev?.syncedUntil != null) carried.syncedUntil = prev.syncedUntil;

  switch (outcome.kind) {
    case 'connected': {
      const at = num(outcome.at) ?? now;
      if (prev != null && prev.connectedAt != null && at <= prev.connectedAt) return prev;
      return { status: 'active', ...carried, connectedAt: at };
    }
    case 'success': {
      const next: ConnectorStatusContent = { status: 'active', ...carried, lastRunAt: now, lastSuccessAt: now };
      const until = num(outcome.syncedUntil);
      if (until != null) next.syncedUntil = until;
      if (prev?.lastError != null) next.lastError = prev.lastError;
      return next;
    }
    case 'reauth':
      return { status: 'needs-reauth', ...carried, lastRunAt: now, lastError: makeError('auth', outcome.code, now) };
    case 'failure': {
      const status: ConnectorStatusValue = outcome.errorClass === 'auth' ? 'needs-reauth' : 'error';
      const errorClass = ERROR_CLASSES.includes(outcome.errorClass) ? outcome.errorClass : 'other';
      return { status, ...carried, lastRunAt: now, lastError: makeError(errorClass, outcome.code, now) };
    }
    case 'disconnected': {
      const next: ConnectorStatusContent = { status: 'disconnected', ...carried };
      if (prev?.lastError != null) next.lastError = prev.lastError;
      return next;
    }
  }
}

// ---- Reading and writing the event ---- //

interface ApiConnection {
  api: (calls: any[]) => Promise<any>;
}

/** An API error result, thrown so the caller can branch on `id` (e.g. `forbidden`). */
export class ConnectorStatusApiError extends Error {
  id: string;
  constructor (method: string, error: { id?: string, message?: string } | undefined) {
    super(`${method} failed: ${error?.id ?? 'unknown-error'}${error?.message != null ? ` (${error.message})` : ''}`);
    this.name = 'ConnectorStatusApiError';
    this.id = error?.id ?? 'unknown-error';
  }
}

/**
 * True for an error that means "this access has no usable leaf": an old grant without the
 * leaf (`forbidden`) or a leaf stream that was never provisioned (`unknown-referenced-resource`).
 */
export function isConnectorStatusAccessError (e: unknown): boolean {
  const id = (e as { id?: unknown })?.id;
  return id === 'forbidden' || id === 'unknown-referenced-resource';
}

interface FoundEvent {
  id: string;
  content: unknown;
  /** Further events on the leaf (a create race between workers); removed on the next write. */
  duplicateIds: string[];
}

/** Read limit: one status plus room to find duplicates left by racing writers. */
const FIND_LIMIT = 10;

async function findStatusEvent (conn: ApiConnection, leafStreamId: string): Promise<FoundEvent | null> {
  const res: any[] = await conn.api([{
    method: 'events.get',
    params: { streams: [leafStreamId], types: [CONNECTOR_STATUS_TYPE], limit: FIND_LIMIT }
  }]);
  if (res?.[0]?.error != null) throw new ConnectorStatusApiError('events.get', res[0].error);
  const events: Array<{ id?: string, content?: unknown }> = (res?.[0]?.events ?? []).filter((e: { id?: string }) => e?.id != null);
  // Pryv returns the most recent first: the same one a reader with `limit: 1` sees.
  const [first, ...rest] = events;
  if (first == null) return null;
  return { id: first.id as string, content: first.content, duplicateIds: rest.map(e => e.id as string) };
}

/** The status on a leaf (sanitized), or null when none is published. Throws on API error. */
export async function readConnectorStatus (
  userConnection: ApiConnection,
  leafStreamId: string
): Promise<ConnectorStatusContent | null> {
  const found = await findStatusEvent(userConnection, leafStreamId);
  return found == null ? null : sanitizeConnectorStatus(found.content);
}

export interface PublishConnectorStatusResult {
  action: 'created' | 'updated';
  eventId: string;
  content: ConnectorStatusContent;
}

async function writeStatus (
  conn: ApiConnection,
  leafStreamId: string,
  existing: FoundEvent | null,
  content: ConnectorStatusContent
): Promise<PublishConnectorStatusResult> {
  const clean = sanitizeConnectorStatus(content);
  if (clean == null) throw new Error(`Invalid connector status content: status ${String(content?.status)}`);
  if (existing != null) {
    const res: any[] = await conn.api([{ method: 'events.update', params: { id: existing.id, update: { content: clean } } }]);
    if (res?.[0]?.error != null) throw new ConnectorStatusApiError('events.update', res[0].error);
    await removeDuplicates(conn, existing.duplicateIds);
    return { action: 'updated', eventId: existing.id, content: clean };
  }
  const res: any[] = await conn.api([{
    method: 'events.create',
    params: { streamIds: [leafStreamId], type: CONNECTOR_STATUS_TYPE, content: clean }
  }]);
  if (res?.[0]?.error != null) throw new ConnectorStatusApiError('events.create', res[0].error);
  const eventId = res?.[0]?.event?.id;
  if (eventId == null) throw new ConnectorStatusApiError('events.create', { id: 'no-event-returned' });
  return { action: 'created', eventId, content: clean };
}

/**
 * Best-effort: trash the extra events a create race left on the leaf (one event per leaf,
 * SYNC-STATUS.md rule 3). Never throws: the status write itself already succeeded.
 */
async function removeDuplicates (conn: ApiConnection, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    await conn.api(ids.map(id => ({ method: 'events.delete', params: { id } })));
  } catch { /* the next write tries again */ }
}

/**
 * Write `content` as the leaf's status: update the existing event in place, else create one.
 * Throws on any API error (the caller decides whether that matters; a sync must not fail on it).
 *
 * Two writers racing on an empty leaf (cluster workers) can both create. Readers use the most
 * recent event (SYNC-STATUS.md rule 3), so does the next write, and that write trashes the
 * others, so the leaf converges back to one event.
 */
export async function publishConnectorStatus (
  userConnection: ApiConnection,
  leafStreamId: string,
  content: ConnectorStatusContent
): Promise<PublishConnectorStatusResult> {
  const existing = await findStatusEvent(userConnection, leafStreamId);
  return await writeStatus(userConnection, leafStreamId, existing, content);
}

/**
 * Read the leaf's status, compute the next one from `outcome`, and write it — one `events.get`
 * for both. Returns `unchanged` (no write) when the outcome leaves the content as it was (a
 * replayed connect). Throws on API error.
 */
export async function recordConnectorOutcome (
  userConnection: ApiConnection,
  leafStreamId: string,
  outcome: ConnectorOutcome,
  now: number = nowSeconds()
): Promise<PublishConnectorStatusResult | { action: 'unchanged', eventId: string, content: ConnectorStatusContent }> {
  const existing = await findStatusEvent(userConnection, leafStreamId);
  const previous = existing == null ? null : sanitizeConnectorStatus(existing.content);
  const next = nextConnectorStatus(previous, outcome, now);
  if (existing != null && previous != null && JSON.stringify(previous) === JSON.stringify(next)) {
    return { action: 'unchanged', eventId: existing.id, content: previous };
  }
  return await writeStatus(userConnection, leafStreamId, existing, next);
}

// ---- Return URL after a partner OAuth ---- //

/**
 * Normalise a configured origin list: keeps each entry's `URL.origin` when it is an https
 * origin, drops anything else. Accepts an array, a JSON array string, or a comma-separated
 * string (env vars arrive as strings).
 */
export function normalizeAllowedOrigins (value: unknown): string[] {
  let list: unknown[] = [];
  if (Array.isArray(value)) {
    list = value;
  } else if (typeof value === 'string' && value.trim() !== '') {
    const s = value.trim();
    if (s.startsWith('[')) {
      try { const parsed = JSON.parse(s); if (Array.isArray(parsed)) list = parsed; } catch { /* not JSON */ }
    } else {
      list = s.split(',');
    }
  }
  const out: string[] = [];
  for (const entry of list) {
    if (typeof entry !== 'string') continue;
    try {
      const u = new URL(entry.trim());
      if (u.protocol !== 'https:') continue;
      if (!out.includes(u.origin)) out.push(u.origin);
    } catch { /* ignore invalid */ }
  }
  return out;
}

/**
 * True when `url` is an absolute https URL whose origin is EXACTLY one of `allowedOrigins`
 * (scheme, host and port). No userinfo. https only: HDS dev hosts are `*.backloop.dev`,
 * which are https too, so there is no plain-http exception. Empty list → false.
 */
export function isAllowedReturnUrl (url: unknown, allowedOrigins: readonly string[] | null | undefined): boolean {
  if (typeof url !== 'string' || url === '') return false;
  const allowed = normalizeAllowedOrigins(allowedOrigins ?? []);
  if (allowed.length === 0) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  if (u.username !== '' || u.password !== '') return false;
  return allowed.includes(u.origin);
}

/**
 * `base` with `params` set in its query string (URL API: existing params kept, a same-named
 * param replaced, values encoded). `undefined`/`null` values are skipped.
 */
export function buildRedirectUrl (base: string, params: Record<string, string | number | null | undefined>): string {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    u.searchParams.set(k, String(v));
  }
  return u.toString();
}
