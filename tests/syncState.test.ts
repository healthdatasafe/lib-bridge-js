import assert from 'node:assert/strict';
import { SyncStateStore, SYNC_STATUS_TYPE } from '../src/lib/syncState.ts';

/**
 * Unit coverage for the shared per-user sync-state store (plan 101 T7). In-memory fake of the
 * Pryv batch `conn.api([...])` shape: API errors come back as results, not throws, and
 * events.create on a missing stream is rejected as the server does.
 */

interface FakeEvent { id: string; streamIds: string[]; type: string; content: any; time: number; created: number }

class FakeConn {
  store = new Map<string, FakeEvent>();
  streams = new Set<string>(['main', 'main-users']);
  seq = 0;
  failCreate = false;
  async api (calls: any[]): Promise<any[]> {
    return calls.map(c => this.one(c.method, c.params));
  }

  add (type: string, content: any, streamId = 'main-users-alice'): FakeEvent {
    this.streams.add(streamId);
    const id = 'e' + (++this.seq);
    const e = { id, streamIds: [streamId], type, content, time: 1000 + this.seq, created: this.seq };
    this.store.set(id, e);
    return e;
  }

  of (type: string): FakeEvent[] {
    return [...this.store.values()].filter(e => e.type === type);
  }

  private one (method: string, params: any): any {
    if (method === 'streams.create') {
      if (this.streams.has(params.id)) return { error: { id: 'item-already-exists' } };
      this.streams.add(params.id);
      return { stream: { id: params.id } };
    }
    if (method === 'events.get') {
      const events = [...this.store.values()]
        .filter(e => params.streams.some((s: string) => e.streamIds.includes(s)) &&
          (params.types == null || params.types.includes(e.type)))
        .sort((a, b) => b.created - a.created)
        .slice(0, params.limit ?? 20);
      return { events };
    }
    if (method === 'events.create') {
      if (this.failCreate) return { error: { id: 'forbidden' } };
      const missing = params.streamIds.filter((s: string) => !this.streams.has(s));
      if (missing.length > 0) return { error: { id: 'unknown-referenced-resource' } };
      const id = 'e' + (++this.seq);
      const e: FakeEvent = { id, streamIds: params.streamIds, type: params.type, content: params.content, time: params.time ?? 1000 + this.seq, created: this.seq };
      this.store.set(id, e);
      return { event: e };
    }
    if (method === 'events.update') {
      const e = this.store.get(params.id);
      if (e == null) return { error: { id: 'unknown-resource' } };
      e.content = JSON.parse(JSON.stringify(params.update.content));
      if (params.update.time != null) e.time = params.update.time;
      return { event: e };
    }
    if (method === 'events.delete') {
      this.store.delete(params.id);
      return { event: { id: params.id, trashed: true } };
    }
    return {};
  }
}

function makeStore (conn: FakeConn, legacyType?: string): SyncStateStore<any> {
  return new SyncStateStore<any>({ connection: () => conn, mainStreamId: () => 'main', legacyType });
}

describe('[SYST] SyncStateStore', () => {
  it('[SYSA] get returns null when nothing is stored', async () => {
    assert.equal(await makeStore(new FakeConn()).get('alice'), null);
  });

  it('[SYSB] first patch creates the user stream and one sync-status/bridge event', async () => {
    const conn = new FakeConn();
    const merged = await makeStore(conn).patch('bob', { lastSyncedAt: 5 }, { needsReauth: false });
    assert.deepEqual(merged, { needsReauth: false, lastSyncedAt: 5 });
    assert.ok(conn.streams.has('main-users-bob'));
    const events = conn.of(SYNC_STATUS_TYPE);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0]!.streamIds, ['main-users-bob']);
  });

  it('[SYSC] later patches update the same event in place and merge', async () => {
    const conn = new FakeConn();
    const store = makeStore(conn);
    await store.patch('alice', { lastSyncedAt: 1, lastError: 'x' });
    await store.patch('alice', { needsReauth: true });
    await store.patch('alice', { lastError: undefined });
    const events = conn.of(SYNC_STATUS_TYPE);
    assert.equal(events.length, 1, 'never appends');
    assert.deepEqual(events[0]!.content, { lastSyncedAt: 1, needsReauth: true });
  });

  it('[SYSD] a stale cached id falls back to create', async () => {
    const conn = new FakeConn();
    const store = makeStore(conn);
    await store.patch('alice', { a: 1 });
    conn.store.clear();
    await store.patch('alice', { b: 2 });
    assert.deepEqual(conn.of(SYNC_STATUS_TYPE)[0]!.content, { b: 2 });
  });

  it('[SYSE] time is written on create and on update', async () => {
    const conn = new FakeConn();
    const store = makeStore(conn);
    await store.patch('alice', { a: 1 }, {}, 42);
    assert.equal(conn.of(SYNC_STATUS_TYPE)[0]!.time, 42);
    await store.patch('alice', { a: 2 }, {}, 43);
    assert.equal(conn.of(SYNC_STATUS_TYPE)[0]!.time, 43);
  });

  it('[SYSF] a legacy event is read when no current one exists', async () => {
    const conn = new FakeConn();
    conn.add('bridge/x-sync-state', { lastSyncedAt: 7, reauthNotifiedAt: 9 });
    const store = makeStore(conn, 'bridge/x-sync-state');
    assert.deepEqual(await store.get('alice'), { lastSyncedAt: 7, reauthNotifiedAt: 9 });
  });

  it('[SYSG] the next patch migrates: new event keeps legacy fields, legacy event deleted', async () => {
    const conn = new FakeConn();
    conn.add('bridge/x-sync-state', { lastSyncedAt: 7, reauthNotifiedAt: 9 });
    const store = makeStore(conn, 'bridge/x-sync-state');
    await store.patch('alice', { needsReauth: true });
    assert.equal(conn.of('bridge/x-sync-state').length, 0);
    const events = conn.of(SYNC_STATUS_TYPE);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0]!.content, { lastSyncedAt: 7, reauthNotifiedAt: 9, needsReauth: true });
    await store.patch('alice', { lastSyncedAt: 8 });
    assert.equal(conn.of(SYNC_STATUS_TYPE).length, 1, 'then updates in place');
  });

  it('[SYSH] the current event wins over a leftover legacy one', async () => {
    const conn = new FakeConn();
    conn.add('bridge/x-sync-state', { lastSyncedAt: 1 });
    conn.add(SYNC_STATUS_TYPE, { lastSyncedAt: 2 });
    assert.deepEqual(await makeStore(conn, 'bridge/x-sync-state').get('alice'), { lastSyncedAt: 2 });
  });

  it('[SYSI] a failed write returns null and keeps the legacy event', async () => {
    const conn = new FakeConn();
    conn.add('bridge/x-sync-state', { lastSyncedAt: 7 });
    conn.failCreate = true;
    assert.equal(await makeStore(conn, 'bridge/x-sync-state').patch('alice', { a: 1 }), null);
    assert.equal(conn.of('bridge/x-sync-state').length, 1);
  });

  it('[SYSJ] delete removes current and legacy events for that user only', async () => {
    const conn = new FakeConn();
    conn.add('bridge/x-sync-state', { a: 1 });
    conn.add(SYNC_STATUS_TYPE, { a: 2 });
    conn.add(SYNC_STATUS_TYPE, { a: 3 }, 'main-users-bob');
    const store = makeStore(conn, 'bridge/x-sync-state');
    await store.delete('alice');
    assert.equal(await store.get('alice'), null);
    assert.deepEqual(await store.get('bob'), { a: 3 });
  });

  it('[SYSK] getEvent exposes the event time', async () => {
    const conn = new FakeConn();
    await makeStore(conn).patch('alice', { a: 1 }, {}, 77);
    assert.deepEqual(await makeStore(conn).getEvent('alice'), { content: { a: 1 }, time: 77 });
  });
});
