import assert from 'node:assert/strict';
import boiler from 'dev-boiler';
import initBoiler from '../src/initBoiler.ts';
import {
  _initForTests, ensureBaseStreams, isValidCmcUserKey, getCmcStreamId, PRYV_STREAM_ID_MAX_LENGTH
} from '../src/lib/bridgeAccount.ts';
import {
  addCredentialToBridgeAccount, deleteCredentialFromBridgeAccount, getCredentialEvent
} from '../src/methods/user.ts';

/**
 * Bridge-account primitives for the CMC module (plan 129 WP3 stage A): credential clientData,
 * reader and guarded delete; `{main}-cmc` base stream; CMC userKey validation. In-memory fake of
 * the Pryv batch API (errors come back as results; delete trashes first, then deletes).
 */

const { getConfig } = boiler;

interface FakeEvent { id: string; streamIds: string[]; type: string; content: any; clientData?: any; trashed?: boolean; time: number }

class FakeConn {
  events: FakeEvent[] = [];
  streams = new Set<string>(['main', 'main-users', 'main-users-active']);
  seq = 0;
  calls: any[] = [];
  async api (calls: any[]): Promise<any[]> {
    this.calls.push(...calls);
    return calls.map(c => this.one(c.method, c.params));
  }

  private one (method: string, p: any): any {
    if (method === 'streams.create') {
      if (this.streams.has(p.id)) return { error: { id: 'item-already-exists' } };
      this.streams.add(p.id);
      return { stream: { id: p.id } };
    }
    if (method === 'streams.get') return { streams: [...this.streams].map(id => ({ id })) };
    if (method === 'events.get') {
      if (p.streams.some((s: string) => !this.streams.has(s))) return { error: { id: 'unknown-referenced-resource' } };
      const events = this.events
        .filter(e => p.streams.some((s: string) => e.streamIds.includes(s)) && p.types.includes(e.type))
        .filter(e => p.state === 'all' || e.trashed !== true)
        .sort((a, b) => b.time - a.time)
        .slice(0, p.limit ?? 20);
      return { events: structuredClone(events) };
    }
    if (method === 'events.create') {
      const e: FakeEvent = { id: 'e' + (++this.seq), time: this.seq, streamIds: p.streamIds, type: p.type, content: p.content };
      if (p.clientData != null) e.clientData = p.clientData;
      this.events.push(e);
      return { event: e };
    }
    if (method === 'events.update') {
      const e = this.events.find(x => x.id === p.id);
      if (e == null) return { error: { id: 'unknown-resource' } };
      Object.assign(e, structuredClone(p.update));
      return { event: e };
    }
    if (method === 'events.delete') {
      const e = this.events.find(x => x.id === p.id);
      if (e == null) return { error: { id: 'unknown-resource' } };
      if (e.trashed !== true) { e.trashed = true; return { event: e }; }
      this.events = this.events.filter(x => x !== e);
      return { eventDeletion: { id: e.id } };
    }
    return {};
  }
}

const CRED = 'credentials/pryv-api-endpoint';

describe('[CRED] bridge-account credentials for CMC', function () {
  let conn: FakeConn;
  let restore: () => void;
  beforeEach(() => {
    conn = new FakeConn();
    restore = _initForTests(conn, 'main');
  });
  afterEach(() => restore());

  it('[CRDA] add without clientData behaves as before (no clientData written)', async () => {
    await addCredentialToBridgeAccount('alice', 'https://t1@alice.example/');
    await addCredentialToBridgeAccount('alice', 'https://t2@alice.example/');
    const creds = conn.events.filter(e => e.type === CRED);
    assert.equal(creds.length, 1);
    assert.equal(creds[0]!.content, 'https://t2@alice.example/');
    assert.equal(creds[0]!.clientData, undefined);
    assert.deepEqual(creds[0]!.streamIds, ['main-users-alice', 'main-users-active']);
  });

  it('[CRDB] clientData is set on create and merged on update', async () => {
    await addCredentialToBridgeAccount('alice', 'https://t1@alice.example/', { clientData: { other: 1, hdsCmc: { generation: 'g1' } } });
    await addCredentialToBridgeAccount('alice', 'https://t2@alice.example/', { clientData: { hdsCmc: { generation: 'g2' } } });
    const cred = await getCredentialEvent('alice');
    assert.deepEqual(cred, { id: 'e1', apiEndpoint: 'https://t2@alice.example/', clientData: { other: 1, hdsCmc: { generation: 'g2' } } });
    await addCredentialToBridgeAccount('alice', 'https://t3@alice.example/');
    assert.deepEqual((await getCredentialEvent('alice'))!.clientData, { other: 1, hdsCmc: { generation: 'g2' } }, 'kept when not given');
  });

  it('[CRDC] getCredentialEvent: null for an unknown user, {} clientData when none', async () => {
    assert.equal(await getCredentialEvent('nobody'), null);
    await addCredentialToBridgeAccount('bob', 'https://t@bob.example/');
    assert.deepEqual((await getCredentialEvent('bob'))!.clientData, {});
  });

  it('[CRDD] delete trashes then deletes every credential event of the user (duplicates included)', async () => {
    await addCredentialToBridgeAccount('alice', 'https://t1@alice.example/');
    conn.events.push({ id: 'dup', time: 0, streamIds: ['main-users-alice'], type: CRED, content: 'https://old@alice.example/', trashed: true });
    await addCredentialToBridgeAccount('bob', 'https://t@bob.example/');
    assert.equal(await deleteCredentialFromBridgeAccount('alice'), 'deleted');
    assert.equal(conn.events.filter(e => e.streamIds.includes('main-users-alice')).length, 0);
    assert.equal(conn.events.filter(e => e.streamIds.includes('main-users-active')).length, 1, 'bob still active');
    assert.equal(await getCredentialEvent('alice'), null);
  });

  it('[CRDE] delete guarded by clientData: refused on mismatch, deleted on match', async () => {
    await addCredentialToBridgeAccount('alice', 'https://t@alice.example/', { clientData: { hdsCmc: { generation: 'g2' } } });
    const gen = (g: string) => (cd: Record<string, any>) => cd.hdsCmc?.generation === g;
    assert.equal(await deleteCredentialFromBridgeAccount('alice', { onlyIfClientData: gen('g1') }), 'refused');
    assert.ok(await getCredentialEvent('alice') != null);
    assert.equal(await deleteCredentialFromBridgeAccount('alice', { onlyIfClientData: gen('g2') }), 'deleted');
    assert.equal(await getCredentialEvent('alice'), null);
  });

  it('[CRDF] delete with nothing stored answers none', async () => {
    assert.equal(await deleteCredentialFromBridgeAccount('nobody'), 'none');
    conn.streams.add('main-users-empty');
    assert.equal(await deleteCredentialFromBridgeAccount('empty'), 'none');
  });

  it('[CRDG] a read error is thrown without the apiEndpoint', async () => {
    await addCredentialToBridgeAccount('alice', 'https://secret-token@alice.example/');
    conn.api = async (calls: any[]) => calls.map(() => ({ error: { id: 'forbidden', message: 'x' } }));
    await assert.rejects(() => getCredentialEvent('alice'), (e: any) => !JSON.stringify({ m: e.message, o: e.errorObject }).includes('secret-token'));
  });
});

describe('[CMCS] ensureBaseStreams and CMC userKey', function () {
  let conn: FakeConn;
  let restore: () => void;
  before(() => { initBoiler(`bridge-cmcs:${process.pid}`); });
  beforeEach(() => {
    conn = new FakeConn();
    restore = _initForTests(conn, 'main');
  });
  afterEach(async () => {
    (await getConfig()).set('cmc:enabled', false);
    restore();
  });

  it('[CMSA] {main}-cmc is created only when cmc:enabled is true', async () => {
    await ensureBaseStreams();
    assert.ok(!conn.streams.has('main-cmc'));
    assert.ok(conn.streams.has('main-errors'));
    (await getConfig()).set('cmc:enabled', true);
    await ensureBaseStreams();
    assert.ok(conn.streams.has('main-cmc'));
    assert.equal(getCmcStreamId(), 'main-cmc');
  });

  it('[CMSB] a create error with the stream present (concurrent start-up) is tolerated', async () => {
    (await getConfig()).set('cmc:enabled', true);
    for (const s of ['main-users', 'main-users-active', 'main-errors', 'main-cmc']) conn.streams.add(s);
    const realApi = conn.api.bind(conn);
    conn.api = async (calls: any[]) => calls[0].method === 'streams.create'
      ? calls.map(() => ({ error: { id: 'unexpected-error' } }))
      : realApi(calls);
    await ensureBaseStreams();
  });

  it('[CMSC] a missing {main}-cmc after a create error fails', async () => {
    (await getConfig()).set('cmc:enabled', true);
    const realApi = conn.api.bind(conn);
    conn.api = async (calls: any[]) => calls[0].method === 'streams.create'
      ? calls.map(() => ({ error: { id: 'unexpected-error' } }))
      : realApi(calls);
    await assert.rejects(() => ensureBaseStreams(), /Failed creating base streams/);
  });

  it('[CMSD] isValidCmcUserKey: charset, first char, length cap from the prefix, not "active"', () => {
    assert.equal(PRYV_STREAM_ID_MAX_LENGTH, 100);
    const max = 100 - 'main-users-'.length;
    assert.equal(isValidCmcUserKey('alice'), true);
    assert.equal(isValidCmcUserKey('alice-demo-datasafe-dev'), true);
    assert.equal(isValidCmcUserKey('0abc'), true);
    assert.equal(isValidCmcUserKey('a'.repeat(max)), true);
    assert.equal(isValidCmcUserKey('a'.repeat(max + 1)), false);
    for (const bad of ['', '-alice', 'Alice', 'al_ice', 'al.ice', 'al ice', 'active', 'ali:ce']) {
      assert.equal(isValidCmcUserKey(bad), false, JSON.stringify(bad));
    }
    assert.equal(isValidCmcUserKey(42), false);
    assert.equal(isValidCmcUserKey('a'.repeat(max), 'a-much-longer-main'), false, 'cap follows the given main');
  });
});
