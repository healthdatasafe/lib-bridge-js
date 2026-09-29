/**
 * Durable per-user sync state on the bridge account: ONE `sync-status/bridge` event in the
 * per-user stream (`{mainStreamId}-users-{partnerUserId}`), updated in place.
 *
 * Why this exists (plan 101 T7): the framework's `logSyncStatus` appended a new
 * `sync-status/bridge` event on every call, so the account grew without bound, and no live
 * bridge used it. bridge-mira and bridge-tempdrop each wrote their own
 * `bridge/<key>-sync-state` event instead, with identical code. So `GET /user/:id/status`,
 * which reads `sync-status/bridge`, always reported an empty `lastSync` for them. This store is
 * that bridge code, moved here, writing the declared data-model type.
 *
 * `legacyType` migrates lazily: when no `sync-status/bridge` event exists, the legacy event is
 * read instead; the next write creates the new event and deletes the legacy one.
 *
 * The event-id cache is per worker; a stale id falls back to create. Concurrent writers can race
 * to create a duplicate (last writer wins); reads use `limit: 1`, so they stay consistent.
 */

export const SYNC_STATUS_TYPE = 'sync-status/bridge';

interface ApiConnection {
  api: (calls: any[]) => Promise<any>;
}

export interface SyncStateStoreOptions {
  /** Bridge-account connection. A getter, because plugins receive it after construction. */
  connection: () => ApiConnection;
  /** `service:bridgeAccountMainStreamId`. */
  mainStreamId: () => string;
  /** Former per-bridge event type (e.g. `bridge/mira-sync-state`), read and migrated. */
  legacyType?: string;
}

interface Located {
  event: { id: string, content: any, time?: number } | null;
  legacy: boolean;
}

export class SyncStateStore<T extends object = Record<string, unknown>> {
  #opts: SyncStateStoreOptions;
  #eventIds = new Map<string, string>();

  constructor (opts: SyncStateStoreOptions) {
    this.#opts = opts;
  }

  streamIdFor (partnerUserId: string): string {
    return `${this.#opts.mainStreamId()}-users-${partnerUserId}`;
  }

  async #locate (partnerUserId: string): Promise<Located> {
    const streams = [this.streamIdFor(partnerUserId)];
    const calls: any[] = [{ method: 'events.get', params: { streams, types: [SYNC_STATUS_TYPE], limit: 1 } }];
    if (this.#opts.legacyType != null) {
      calls.push({ method: 'events.get', params: { streams, types: [this.#opts.legacyType], limit: 1 } });
    }
    const res: any[] = await this.#opts.connection().api(calls);
    const current = res[0]?.events?.[0];
    if (current != null) {
      this.#eventIds.set(partnerUserId, current.id);
      return { event: current, legacy: false };
    }
    this.#eventIds.delete(partnerUserId);
    const legacy = res[1]?.events?.[0];
    return { event: legacy ?? null, legacy: legacy != null };
  }

  /** The stored state for a user, or null if none. */
  async get (partnerUserId: string): Promise<T | null> {
    const { event } = await this.#locate(partnerUserId);
    return event == null ? null : event.content as T;
  }

  /** The stored event (content and time), or null. */
  async getEvent (partnerUserId: string): Promise<{ content: T, time?: number } | null> {
    const { event } = await this.#locate(partnerUserId);
    return event == null ? null : { content: event.content as T, time: event.time };
  }

  /**
   * Merge `partial` onto the stored state and persist it. A field set to `undefined` is
   * cleared (dropped by JSON serialization). `defaults` fill fields absent from both.
   * `time` (Pryv seconds) sets the event time when given.
   * Returns the merged state, or null when the write failed (never throws on an API error
   * result, like the bridge code it replaces: a sync must not fail because its bookkeeping did).
   */
  async patch (partnerUserId: string, partial: Partial<T>, defaults: Partial<T> = {}, time?: number): Promise<T | null> {
    const { event, legacy } = await this.#locate(partnerUserId);
    const merged = { ...defaults, ...(event?.content ?? {}), ...partial } as T;
    const conn = this.#opts.connection();

    const eventId = this.#eventIds.get(partnerUserId);
    if (!legacy && eventId != null) {
      const update: Record<string, unknown> = { content: merged };
      if (time != null) update.time = time;
      try {
        const upd: any[] = await conn.api([{ method: 'events.update', params: { id: eventId, update } }]);
        if (upd[0]?.error == null) return merged;
      } catch { /* fall through to create */ }
      this.#eventIds.delete(partnerUserId);
    }

    const streamId = this.streamIdFor(partnerUserId);
    const params: Record<string, unknown> = { streamIds: [streamId], type: SYNC_STATUS_TYPE, content: merged };
    if (time != null) params.time = time;
    // The per-user stream normally exists (created with the user's credential), but a sync can
    // be the first writer on an account that never served this user: events.create alone then
    // fails with `unknown-referenced-resource`. An existing stream answers item-already-exists.
    const created: any[] = await conn.api([
      { method: 'streams.create', params: { id: streamId, parentId: `${this.#opts.mainStreamId()}-users`, name: partnerUserId } },
      { method: 'events.create', params }
    ]);
    const newEvent = created[1]?.event;
    if (newEvent?.id == null) return null;
    this.#eventIds.set(partnerUserId, newEvent.id);
    if (legacy && event != null) {
      await conn.api([{ method: 'events.delete', params: { id: event.id } }]);
    }
    return merged;
  }

  /** Delete the stored state (current and legacy events) for a user. */
  async delete (partnerUserId: string): Promise<void> {
    const streams = [this.streamIdFor(partnerUserId)];
    const types = [SYNC_STATUS_TYPE];
    if (this.#opts.legacyType != null) types.push(this.#opts.legacyType);
    const conn = this.#opts.connection();
    try {
      // Explicit limit: Pryv defaults to 20, and accounts where the old append-per-call
      // logSyncStatus ran can hold many more.
      const res: any[] = await conn.api([{ method: 'events.get', params: { streams, types, limit: 10000 } }]);
      const ids: string[] = (res[0]?.events ?? []).map((e: { id: string }) => e.id);
      if (ids.length > 0) await conn.api(ids.map(id => ({ method: 'events.delete', params: { id } })));
    } finally {
      this.#eventIds.delete(partnerUserId);
    }
  }
}
