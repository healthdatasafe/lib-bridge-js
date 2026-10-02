import assert from 'node:assert/strict';
import {
  CONNECTOR_STATUS_TYPE,
  nextConnectorStatus,
  sanitizeConnectorStatus,
  readConnectorStatus,
  publishConnectorStatus,
  recordConnectorOutcome,
  isConnectorStatusAccessError,
  normalizeAllowedOrigins,
  isAllowedReturnUrl,
  buildRedirectUrl
} from '../src/lib/connectorStatus.ts';
import type { ConnectorStatusContent } from '../src/lib/connectorStatus.ts';

/**
 * Unit coverage for the connector status published in the user's account
 * (`sync-status/connector-v1` on `sync-status-<connector>`) and the return-URL helpers.
 * In-memory fake of the Pryv batch `conn.api([...])` shape: API errors are results.
 */

interface FakeEvent { id: string; streamIds: string[]; type: string; content: any; created: number }

class FakeUserConn {
  store = new Map<string, FakeEvent>();
  seq = 0;
  /** Streams the access may use; anything else answers `forbidden`. */
  allowed = new Set<string>(['sync-status-mira']);
  calls: string[] = [];
  failUpdate = false;
  async api (calls: any[]): Promise<any[]> {
    return calls.map(c => { this.calls.push(c.method); return this.one(c.method, c.params); });
  }

  private one (method: string, params: any): any {
    if (method === 'events.get') {
      if (!params.streams.every((s: string) => this.allowed.has(s))) return { error: { id: 'forbidden' } };
      const events = [...this.store.values()]
        .filter(e => params.streams.some((s: string) => e.streamIds.includes(s)) && params.types.includes(e.type))
        .sort((a, b) => b.created - a.created)
        .slice(0, params.limit ?? 20);
      return { events };
    }
    if (method === 'events.create') {
      if (!params.streamIds.every((s: string) => this.allowed.has(s))) return { error: { id: 'forbidden' } };
      const id = 'e' + (++this.seq);
      const e: FakeEvent = { id, streamIds: params.streamIds, type: params.type, content: params.content, created: this.seq };
      this.store.set(id, e);
      return { event: e };
    }
    if (method === 'events.update') {
      if (this.failUpdate) return { error: { id: 'invalid-parameters-format', message: 'nope' } };
      const e = this.store.get(params.id);
      if (e == null) return { error: { id: 'unknown-resource' } };
      e.content = JSON.parse(JSON.stringify(params.update.content));
      return { event: e };
    }
    if (method === 'events.delete') {
      this.store.delete(params.id);
      return { event: { id: params.id, trashed: true } };
    }
    return {};
  }

  events (): FakeEvent[] { return [...this.store.values()]; }
}

const LEAF = 'sync-status-mira';

describe('[CSTX] connector status — nextConnectorStatus (pure)', () => {
  it('[CSTA] connected from nothing: active + connectedAt, nothing else', () => {
    assert.deepEqual(nextConnectorStatus(null, { kind: 'connected' }, 100), { status: 'active', connectedAt: 100 });
    assert.deepEqual(nextConnectorStatus(null, { kind: 'connected', at: 90 }, 100), { status: 'active', connectedAt: 90 });
  });

  it('[CSTB] a fresh connect resets connectedAt and drops lastError, keeps run fields', () => {
    const prev: ConnectorStatusContent = {
      status: 'disconnected',
      connectedAt: 10,
      lastRunAt: 50,
      lastSuccessAt: 40,
      syncedUntil: 30,
      lastError: { class: 'auth', code: 'mira-reauth-required', at: 50 }
    };
    assert.deepEqual(nextConnectorStatus(prev, { kind: 'connected' }, 100),
      { status: 'active', connectedAt: 100, lastRunAt: 50, lastSuccessAt: 40, syncedUntil: 30 });
  });

  it('[CSTC] a replayed connect (not newer than connectedAt) changes nothing', () => {
    const prev: ConnectorStatusContent = { status: 'disconnected', connectedAt: 100 };
    assert.deepEqual(nextConnectorStatus(prev, { kind: 'connected', at: 100 }, 500), prev);
    assert.deepEqual(nextConnectorStatus(prev, { kind: 'connected', at: 99 }, 500), prev);
    assert.equal(nextConnectorStatus(prev, { kind: 'connected', at: 101 }, 500).status, 'active');
  });

  it('[CSTD] success: active, lastRunAt = lastSuccessAt = now, carries connectedAt/syncedUntil/lastError', () => {
    const prev: ConnectorStatusContent = {
      status: 'error', connectedAt: 10, lastRunAt: 20, lastSuccessAt: 15, syncedUntil: 12, lastError: { class: 'upstream', code: 'mira-http-503', at: 20 }
    };
    assert.deepEqual(nextConnectorStatus(prev, { kind: 'success' }, 100), {
      status: 'active', connectedAt: 10, lastRunAt: 100, lastSuccessAt: 100, syncedUntil: 12, lastError: { class: 'upstream', code: 'mira-http-503', at: 20 }
    });
    assert.equal(nextConnectorStatus(prev, { kind: 'success', syncedUntil: 99 }, 100).syncedUntil, 99);
  });

  it('[CSTE] success with no previous status has no connectedAt and no syncedUntil', () => {
    assert.deepEqual(nextConnectorStatus(null, { kind: 'success' }, 100), { status: 'active', lastRunAt: 100, lastSuccessAt: 100 });
  });

  it('[CSTF] reauth: needs-reauth + lastError {class: auth}, carries lastSuccessAt', () => {
    const prev: ConnectorStatusContent = { status: 'active', connectedAt: 10, lastRunAt: 20, lastSuccessAt: 20 };
    assert.deepEqual(nextConnectorStatus(prev, { kind: 'reauth', code: 'mira-reauth-required' }, 100), {
      status: 'needs-reauth', connectedAt: 10, lastRunAt: 100, lastSuccessAt: 20, lastError: { class: 'auth', code: 'mira-reauth-required', at: 100 }
    });
  });

  it('[CSTG] failure: error + lastError {class, code}; class auth means needs-reauth', () => {
    const prev: ConnectorStatusContent = { status: 'active', connectedAt: 10, lastSuccessAt: 20 };
    assert.deepEqual(nextConnectorStatus(prev, { kind: 'failure', errorClass: 'hds', code: 'hds-write-failed' }, 100), {
      status: 'error', connectedAt: 10, lastRunAt: 100, lastSuccessAt: 20, lastError: { class: 'hds', code: 'hds-write-failed', at: 100 }
    });
    assert.equal(nextConnectorStatus(prev, { kind: 'failure', errorClass: 'auth' }, 100).status, 'needs-reauth');
  });

  it('[CSTH] an invalid code is dropped, never written', () => {
    const next = nextConnectorStatus(null, { kind: 'failure', errorClass: 'upstream', code: 'Mira said: token expired!' }, 100);
    assert.deepEqual(next.lastError, { class: 'upstream', at: 100 });
    assert.equal(nextConnectorStatus(null, { kind: 'failure', errorClass: 'other', code: 'x'.repeat(65) }, 1).lastError?.code, undefined);
    assert.equal(nextConnectorStatus(null, { kind: 'failure', errorClass: 'other', code: 'x'.repeat(64) }, 1).lastError?.code, 'x'.repeat(64));
  });

  it('[CSTI] disconnected keeps the history, only the status changes', () => {
    const prev: ConnectorStatusContent = { status: 'active', connectedAt: 10, lastRunAt: 20, lastSuccessAt: 20, lastError: { class: 'other', at: 5 } };
    assert.deepEqual(nextConnectorStatus(prev, { kind: 'disconnected' }, 100), { ...prev, status: 'disconnected' });
  });

  it('[CSTJ] sanitize drops unknown fields and malformed values (the schema is closed)', () => {
    assert.equal(sanitizeConnectorStatus(null), null);
    assert.equal(sanitizeConnectorStatus({ status: 'weird' }), null);
    assert.deepEqual(sanitizeConnectorStatus({
      status: 'active', connectedAt: '10', lastRunAt: 5, extra: 1, lastError: { class: 'nope', at: 1 }
    }), { status: 'active', lastRunAt: 5 });
    assert.deepEqual(sanitizeConnectorStatus({ status: 'error', lastError: { class: 'hds', code: 'BAD', at: 3, msg: 'x' } }),
      { status: 'error', lastError: { class: 'hds', at: 3 } });
  });
});

describe('[CSTX] connector status — read / publish / record', () => {
  it('[CSPA] read returns null on an empty leaf', async () => {
    assert.equal(await readConnectorStatus(new FakeUserConn(), LEAF), null);
  });

  it('[CSPB] publish creates once, then updates the same event in place', async () => {
    const conn = new FakeUserConn();
    const r1 = await publishConnectorStatus(conn, LEAF, { status: 'active', connectedAt: 1 });
    assert.equal(r1.action, 'created');
    const r2 = await publishConnectorStatus(conn, LEAF, { status: 'error', connectedAt: 1, lastError: { class: 'other', at: 2 } });
    assert.equal(r2.action, 'updated');
    assert.equal(r2.eventId, r1.eventId);
    const events = conn.events();
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, CONNECTOR_STATUS_TYPE);
    assert.deepEqual(events[0]!.streamIds, [LEAF]);
    assert.deepEqual(await readConnectorStatus(conn, LEAF), { status: 'error', connectedAt: 1, lastError: { class: 'other', at: 2 } });
  });

  it('[CSPC] publish replaces the whole content (no merge)', async () => {
    const conn = new FakeUserConn();
    await publishConnectorStatus(conn, LEAF, { status: 'error', lastError: { class: 'other', at: 2 } });
    await publishConnectorStatus(conn, LEAF, { status: 'active', connectedAt: 3 });
    assert.deepEqual(conn.events()[0]!.content, { status: 'active', connectedAt: 3 });
  });

  it('[CSPD] an access without the leaf throws a recognisable access error', async () => {
    const conn = new FakeUserConn();
    conn.allowed.clear();
    await assert.rejects(() => publishConnectorStatus(conn, LEAF, { status: 'active' }), (e: unknown) => {
      assert.equal(isConnectorStatusAccessError(e), true);
      assert.equal((e as { id: string }).id, 'forbidden');
      return true;
    });
    await assert.rejects(() => readConnectorStatus(conn, LEAF), (e: unknown) => isConnectorStatusAccessError(e));
  });

  it('[CSPE] an update error throws (callers decide)', async () => {
    const conn = new FakeUserConn();
    await publishConnectorStatus(conn, LEAF, { status: 'active' });
    conn.failUpdate = true;
    await assert.rejects(() => publishConnectorStatus(conn, LEAF, { status: 'error', lastError: { class: 'other', at: 1 } }), (e: unknown) => {
      assert.equal(isConnectorStatusAccessError(e), false);
      assert.match(String((e as Error).message), /events.update failed: invalid-parameters-format/);
      return true;
    });
  });

  it('[CSPF] publish refuses a content that is not a status', async () => {
    await assert.rejects(() => publishConnectorStatus(new FakeUserConn(), LEAF, { status: 'bogus' } as any), /Invalid connector status/);
  });

  it('[CSPG] record: one get, then create/update with the computed content', async () => {
    const conn = new FakeUserConn();
    const r1 = await recordConnectorOutcome(conn, LEAF, { kind: 'connected', at: 10 }, 10);
    assert.equal(r1.action, 'created');
    const r2 = await recordConnectorOutcome(conn, LEAF, { kind: 'success' }, 20);
    assert.equal(r2.action, 'updated');
    assert.deepEqual(r2.content, { status: 'active', connectedAt: 10, lastRunAt: 20, lastSuccessAt: 20 });
    assert.deepEqual(conn.calls, ['events.get', 'events.create', 'events.get', 'events.update']);
  });

  it('[CSPI] duplicates left by a create race are trashed on the next write; the newest is kept', async () => {
    const conn = new FakeUserConn();
    await publishConnectorStatus(conn, LEAF, { status: 'active', connectedAt: 1 });
    // a second worker raced and created its own
    const raced = await (conn as any).one('events.create', { streamIds: [LEAF], type: CONNECTOR_STATUS_TYPE, content: { status: 'active', connectedAt: 2 } });
    const r = await recordConnectorOutcome(conn, LEAF, { kind: 'success' }, 50);
    assert.equal(r.eventId, raced.event.id, 'the most recent is the status');
    assert.deepEqual(conn.events().map(e => e.id), [raced.event.id], 'one event left');
    assert.equal(conn.events()[0]!.content.connectedAt, 2);
  });

  it('[CSPH] record: a replayed connect does not write', async () => {
    const conn = new FakeUserConn();
    await recordConnectorOutcome(conn, LEAF, { kind: 'connected', at: 10 }, 10);
    await recordConnectorOutcome(conn, LEAF, { kind: 'disconnected' }, 20);
    conn.calls = [];
    const r = await recordConnectorOutcome(conn, LEAF, { kind: 'connected', at: 10 }, 30);
    assert.equal(r.action, 'unchanged');
    assert.equal(r.content.status, 'disconnected');
    assert.deepEqual(conn.calls, ['events.get']);
  });
});

describe('[CSRU] return URL helpers', () => {
  const ORIGINS = ['https://demo-account.datasafe.dev', 'https://demo-app.datasafe.dev'];

  it('[CSRA] exact origin match only', () => {
    assert.equal(isAllowedReturnUrl('https://demo-account.datasafe.dev/connect/return?nonce=abc', ORIGINS), true);
    assert.equal(isAllowedReturnUrl('https://demo-app.datasafe.dev/', ORIGINS), true);
    assert.equal(isAllowedReturnUrl('https://evil.demo-account.datasafe.dev/x', ORIGINS), false);
    assert.equal(isAllowedReturnUrl('https://demo-account.datasafe.dev.evil.com/x', ORIGINS), false);
    assert.equal(isAllowedReturnUrl('https://demo-account.datasafe.dev:8443/x', ORIGINS), false);
  });

  it('[CSRB] https only, no userinfo, absolute only', () => {
    assert.equal(isAllowedReturnUrl('http://demo-account.datasafe.dev/x', ORIGINS), false);
    assert.equal(isAllowedReturnUrl('https://demo-account.datasafe.dev@evil.com/x', ORIGINS), false);
    assert.equal(isAllowedReturnUrl('https://user:pw@demo-account.datasafe.dev/x', ORIGINS), false);
    assert.equal(isAllowedReturnUrl('/connect/return', ORIGINS), false);
    assert.equal(isAllowedReturnUrl('javascript:alert(1)', ORIGINS), false);
    assert.equal(isAllowedReturnUrl(undefined, ORIGINS), false);
  });

  it('[CSRC] empty or missing allow-list refuses everything', () => {
    assert.equal(isAllowedReturnUrl('https://demo-account.datasafe.dev/x', []), false);
    assert.equal(isAllowedReturnUrl('https://demo-account.datasafe.dev/x', null), false);
  });

  it('[CSRD] origins normalise from arrays, JSON strings and comma lists; non-https dropped', () => {
    assert.deepEqual(normalizeAllowedOrigins(['https://a.example/', 'http://b.example', 'nope', 'https://a.example']), ['https://a.example']);
    assert.deepEqual(normalizeAllowedOrigins('["https://a.example","https://b.example/path"]'), ['https://a.example', 'https://b.example']);
    assert.deepEqual(normalizeAllowedOrigins('https://a.example, https://b.example'), ['https://a.example', 'https://b.example']);
    assert.deepEqual(normalizeAllowedOrigins(null), []);
    assert.deepEqual(normalizeAllowedOrigins(''), []);
  });

  it('[CSRE] buildRedirectUrl appends encoded params and keeps existing ones', () => {
    const cap = 'https://tok@demo.datasafe.dev/bridge/?x=1&y=2';
    const url = buildRedirectUrl('https://demo-account.datasafe.dev/connect/return?nonce=abc', { capabilityUrl: cap, skip: undefined });
    const u = new URL(url);
    assert.equal(u.searchParams.get('nonce'), 'abc');
    assert.equal(u.searchParams.get('capabilityUrl'), cap);
    assert.equal(u.searchParams.has('skip'), false);
    assert.equal(new URL(buildRedirectUrl('https://a.example/p?error=old#frag', { error: 'partner-denied' })).searchParams.get('error'), 'partner-denied');
  });
});
