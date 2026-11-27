import assert from 'node:assert/strict';
import boiler from 'dev-boiler';
import express from 'express';
import request from 'supertest';
import initBoiler from '../src/initBoiler.ts';
import { _initForTests } from '../src/lib/bridgeAccount.ts';
import { getCredentialEvent } from '../src/methods/user.ts';
import { cacheDel, cacheLock, cacheUnlock } from '../src/lib/cache.ts';
import { setTelemetryHolderForTests, CMC_METHOD_IDS, CMC_ERROR_CODES } from '../src/lib/observability.ts';
import { createCmcRelationships, _testInternals } from '../src/cmc/index.ts';
import { unionPermissions, levelContains, dataPermissions } from '../src/cmc/scope.ts';
import { withLease } from '../src/cmc/context.ts';
import { teardownLocked } from '../src/cmc/revoke.ts';
import type { CmcHooks, CmcRelationships, CmcRelationshipsOptions } from '../src/cmc/types.ts';
import { FakeBridge, FakeGrant } from './helpers/cmcFake.ts';

/**
 * CMC relationship module (plan 129 WP3 stage B), DESIGN.md §11 "Unit": fake bridge account and
 * fake data grants, the loops run one tick at a time, the clock injected.
 */

const { getConfig } = boiler;
const SCOPE = ':_cmc:apps:hds-bridge-reader';
const ACCEPT = 'consent/accept-cmc';
const REVOKE = 'consent/revoke-cmc';
const HOST = 'datasafe.test';
const KEY = (u: string) => `${u}--datasafe-test`;
const ep = (u: string, t: string) => `https://${t}@${u}.datasafe.test/`;

/** `errors` is reset by tests that count; `all*` keep everything for the closed-set check. */
const telemetry = { errors: [] as string[], allMethods: [] as string[], allErrors: [] as string[] };

describe('[CMC] CMC relationship module', function () {
  let bridge: FakeBridge;
  let grants: Map<string, FakeGrant>;
  let restore: () => void;
  let clock: number;
  let calls: { accepted: any[], revoked: any[], change: any[], answer: any[] };
  let hooks: CmcHooks;
  let cmcRel: CmcRelationships;
  let t: ReturnType<typeof _testInternals>;
  let bcSeq: number;

  before(() => {
    initBoiler(`bridge-cmc:${process.pid}`);
    setTelemetryHolderForTests({
      obs: {
        recordCall: (m: string) => { telemetry.allMethods.push(m); },
        recordError: (c: string) => { telemetry.errors.push(c); telemetry.allErrors.push(c); }
      } as any
    });
  });
  after(() => {
    setTelemetryHolderForTests(null);
    // closed telemetry sets: every id the module recorded across this suite is declared
    assert.ok(telemetry.allMethods.length > 0);
    for (const m of telemetry.allMethods) assert.ok((CMC_METHOD_IDS as readonly string[]).includes(m), m);
    for (const c of telemetry.allErrors) assert.ok((CMC_ERROR_CODES as readonly string[]).includes(c), c);
    for (const c of ['cmc_accept_host', 'cmc_accept_unknown_invite', 'cmc_accept_wrong_person', 'cmc_inbox_retry', 'cmc_revoke_confirmed',
      'cmc_scope_request_open', 'cmc_webhook_reactivated', 'cmc_webhook_recreated', 'cmc_dispatch_coalesced']) {
      assert.ok(telemetry.allErrors.includes(c), `${c} exercised`);
    }
  });

  function make (opts: Partial<CmcRelationshipsOptions> = {}): void {
    cmcRel = createCmcRelationships({
      hooks,
      apiEndpointHostPattern: '\\.datasafe\\.test',
      patientAppBaseUrl: 'https://demo-app.datasafe.test', // the test config's serviceInfoURL is demo's
      bridgeConnection: () => bridge,
      connectionFor: (e: string) => grants.get(e) ?? Object.assign(new FakeGrant({ id: 'x', user: { username: 'x' }, permissions: [] }), { state: 'gone' }),
      now: () => clock,
      sleep: async (ms: number) => { clock += ms; },
      isScheduler: () => true,
      ...opts
    });
    t = _testInternals(cmcRel);
  }

  beforeEach(async () => {
    bridge = new FakeBridge();
    restore = _initForTests(bridge, 'main');
    grants = new Map();
    clock = 10_000_000; // 10000 s
    bcSeq = 0;
    calls = { accepted: [], revoked: [], change: [], answer: [] };
    hooks = {
      requestedPermissions: () => [{ streamId: 'hds-reader-inbox', level: 'read' }],
      onAccepted: async (rel, c) => { calls.accepted.push({ userKey: rel.userKey, generation: rel.record.generation, ...c }); },
      onRevoked: async (rel, reason) => { calls.revoked.push({ userKey: rel.userKey, generation: rel.record.generation, reason }); },
      onChange: async (rel, c) => { calls.change.push({ userKey: rel.userKey, ...c }); },
      onScopeAnswer: async (rel, a) => { calls.answer.push({ userKey: rel.userKey, ...a }); }
    };
    for (const k of ['cmc:hook-rebuilt']) await cacheDel(k);
    make();
  });
  afterEach(async () => {
    await cmcRel.stop();
    restore();
  });

  /** A person's data grant on the platform. */
  function person (username: string, token = 't1', permissions: any[] = [{ streamId: 'hds-reader-inbox', level: 'read' }]): { endpoint: string, grant: FakeGrant } {
    const endpoint = ep(username, token);
    const grant = new FakeGrant({ id: `grant-${username}-${token}`, user: { username }, permissions: [...permissions, { streamId: `${SCOPE}:collectors:x`, level: 'contribute' }] });
    grants.set(endpoint, grant);
    return { endpoint, grant };
  }

  /** An invite, stamped accepted by the core with back-channel `bc`. */
  async function invite (expectedUsername: string | undefined, bc: string): Promise<string> {
    const r = await cmcRel.createInvite({ expectedUsername });
    const trigger = bridge.events.find(e => e.id === r.inviteEventId)!;
    trigger.content.backChannelAccessId = bc;
    return r.inviteEventId;
  }

  function arrive (p: { endpoint: string, bc: string, inviteEventId: string, username: string, time: number, host?: string, id?: string }) {
    return bridge.add({
      id: p.id,
      time: p.time,
      streamIds: [':_cmc:inbox'],
      type: ACCEPT,
      content: {
        grantedAccess: { apiEndpoint: p.endpoint },
        backChannelAccessId: p.bc,
        inviteEventId: p.inviteEventId,
        acceptEventId: 'acc-' + p.time,
        from: { username: p.username, host: p.host ?? HOST }
      }
    });
  }

  /** Invite + accept arrival for `username`; returns the pieces. */
  async function connect (username: string, time = 5000, token = 't1', bc?: string) {
    const backChannel = bc ?? 'bc-' + (++bcSeq);
    const p = person(username, token);
    const inviteEventId = await invite(username, backChannel);
    const arrival = arrive({ endpoint: p.endpoint, bc: backChannel, inviteEventId, username, time });
    return { ...p, bc: backChannel, inviteEventId, arrival };
  }

  const revokesSent = () => bridge.ofType(REVOKE).filter(e => e.streamIds.includes(SCOPE));
  const alertsSent = () => bridge.ofType('notification/alert-cmc');

  // ---- invite ---- //

  it('[CMIA] createInvite: expected username in the marker only, the bridge\'s name as displayName, explicit features, single-use, patient URL', async () => {
    const r = await cmcRel.createInvite({ expectedUsername: 'alice' });
    const trigger = bridge.events.find(e => e.id === r.inviteEventId)!;
    assert.deepEqual(trigger.streamIds, [SCOPE]);
    assert.equal(trigger.content.requesterMeta.displayName, 'hds-bridge-reader', 'never the invited person\'s username');
    assert.deepEqual(trigger.content.request.title, { en: 'hds-bridge-reader' }, 'the invite title names the bridge too');
    assert.equal(trigger.content.requesterMeta.hdsExpectedUsername, 'alice');
    assert.deepEqual(trigger.content.request.features, { chat: false, systemMessaging: true });
    assert.deepEqual(trigger.content.request.permissions, [{ streamId: 'hds-reader-inbox', level: 'read' }]);
    assert.equal(trigger.content.request.expiresAt, 10000 + 604800);
    assert.equal(trigger.content.capability, undefined, 'single-use');
    assert.ok(r.patientUrl.startsWith('https://demo-app.datasafe.test/?action=invite&capabilityUrl=https%3A%2F%2Fcap-'));
    const open = await cmcRel.createInvite({});
    assert.equal(bridge.events.find(e => e.id === open.inviteEventId)!.content.requesterMeta.hdsExpectedUsername, '');
  });

  it('[CMIN] createInvite: the invite\'s display name and title come from cmc:invite:displayName; the binding stays in the marker', async () => {
    make({ invite: { displayName: 'HDS Reader' } });
    const r = await cmcRel.createInvite({ expectedUsername: 'alice' });
    const trigger = bridge.events.find(e => e.id === r.inviteEventId)!;
    assert.equal(trigger.content.requesterMeta.displayName, 'HDS Reader');
    assert.deepEqual(trigger.content.request.title, { en: 'HDS Reader' });
    assert.equal(trigger.content.requesterMeta.hdsExpectedUsername, 'alice');
    const open = await cmcRel.createInvite({});
    assert.equal(bridge.events.find(e => e.id === open.inviteEventId)!.content.requesterMeta.displayName, 'HDS Reader');
  });

  it('[CMIB] createInvite refuses webhooks/accessCreation forbidden while webhooks are on; creates a missing bare scope', async () => {
    make({ webhooks: { enabled: true, publicBaseUrl: 'https://bridge.datasafe.test' } });
    for (const feature of ['webhooks', 'accessCreation']) {
      await assert.rejects(() => cmcRel.createInvite({ requestedPermissions: [{ streamId: 'a', level: 'read' }, { feature, setting: 'forbidden' }] }),
        (e: any) => e.id === 'webhooks-forbidden');
    }
    make();
    await cmcRel.createInvite({ requestedPermissions: [{ streamId: 'a', level: 'read' }, { feature: 'webhooks', setting: 'forbidden' }] });
    bridge.streams.delete(SCOPE);
    make();
    await cmcRel.createInvite({});
    assert.ok(bridge.streams.has(SCOPE), 'bare scope created when missing');
  });

  // ---- accept: verification and refusal ---- //

  it('[CMAA] a verified accept stores credential + record, status, onAccepted; identity from access-info', async () => {
    const c = await connect('alice');
    await t.inboxTick();
    const cred = await getCredentialEvent(KEY('alice'));
    assert.equal(cred!.apiEndpoint, c.endpoint);
    const rec = cred!.clientData.hdsCmc as any;
    assert.equal(rec.relationshipId, c.bc);
    assert.equal(rec.generation, c.arrival.id);
    assert.equal(rec.username, 'alice');
    assert.equal(rec.dataGrantAccessId, 'grant-alice-t1');
    assert.equal(rec.collectorStreamId, `${SCOPE}:collectors:${KEY('alice')}`);
    assert.deepEqual(rec.grantedPermissions, [{ streamId: 'hds-reader-inbox', level: 'read' }], ':_cmc:* left out');
    assert.equal(rec.acceptHookDone, true);
    assert.ok(!JSON.stringify(cred!.clientData).includes('t1@'), 'no endpoint in the record');
    assert.deepEqual(calls.accepted, [{ userKey: KEY('alice'), generation: c.arrival.id, replaced: false }]);
    const rel = await cmcRel.byRelationshipId(c.bc);
    assert.equal(rel!.userKey, KEY('alice'));
    assert.ok(Object.isFrozen(rel!.record));
  });

  it('[CMAB] refusals: foreign host, spoofed from, peer-supplied inviteEventId, wrong person', async () => {
    // foreign host
    const inv1 = await invite('mallory', 'bc-1');
    const evil = 'https://t@mallory.evil.test/';
    grants.set(evil, new FakeGrant({ id: 'g-evil', user: { username: 'mallory' }, permissions: [] }));
    arrive({ endpoint: evil, bc: 'bc-1', inviteEventId: inv1, username: 'mallory', time: 5000 });
    // spoofed from: the grant is bob's, the arrival claims alice
    const bob = person('bob');
    const inv2 = await invite(undefined, 'bc-2');
    arrive({ endpoint: bob.endpoint, bc: 'bc-2', inviteEventId: inv2, username: 'alice', time: 5001 });
    // peer-supplied inviteEventId: names an invite stamped with another back-channel
    const carol = person('carol');
    const inv3 = await invite(undefined, 'bc-other');
    arrive({ endpoint: carol.endpoint, bc: 'bc-3', inviteEventId: inv3, username: 'carol', time: 5002 });
    // an invite id that is not ours at all
    const dan = person('dan');
    arrive({ endpoint: dan.endpoint, bc: 'bc-4', inviteEventId: 'nope', username: 'dan', time: 5003 });
    // wrong person: the invite expected erin, frank accepted (signed in to another account)
    const frank = person('frank');
    const inv5 = await invite('erin', 'bc-5');
    arrive({ endpoint: frank.endpoint, bc: 'bc-5', inviteEventId: inv5, username: 'frank', time: 5004 });

    telemetry.errors.length = 0;
    await t.inboxTick();
    assert.equal(bridge.ofType('credentials/pryv-api-endpoint').length, 0, 'nothing stored');
    assert.deepEqual(telemetry.errors.sort(), [
      'cmc_accept_host', 'cmc_accept_unknown_invite', 'cmc_accept_unknown_invite', 'cmc_accept_wrong_person', 'cmc_accept_wrong_person'
    ]);
    // every refused relationship revoked by accessId, each after its value-free alert
    assert.deepEqual(revokesSent().map(e => e.content.accessId).sort(), ['bc-1', 'bc-2', 'bc-3', 'bc-4', 'bc-5']);
    assert.equal(alertsSent().length, 5);
    const ids = bridge.events.map(e => e.id);
    assert.ok(ids.indexOf(alertsSent()[0]!.id) < ids.indexOf(revokesSent()[0]!.id), 'alert first');
    assert.ok(alertsSent().some(a => a.streamIds[0] === `${SCOPE}:collectors:${KEY('frank')}`), 'addressed to the relationship the core built');
    assert.equal(calls.accepted.length, 0);
  });

  it('[CMAC] a refused accept whose relationship a live record holds is not revoked', async () => {
    const c = await connect('alice', 5000);
    await t.inboxTick();
    // the same relationship comes back through another invite under someone else's name
    const inv = await invite('zoe', c.bc);
    const p2 = person('alice', 't2');
    arrive({ endpoint: p2.endpoint, bc: c.bc, inviteEventId: inv, username: 'alice', time: 5100 });
    await t.inboxTick();
    assert.equal(revokesSent().length, 0);
    assert.equal(alertsSent().length, 0);
    assert.equal((await getCredentialEvent(KEY('alice')))!.apiEndpoint, c.endpoint, 'live record untouched');
  });

  it('[CMAD] legacy invite (no marker): displayName binds the expected username', async () => {
    const p = person('alice');
    const legacy = bridge.add({ time: 1, streamIds: [SCOPE], type: 'consent/request-cmc', content: { requesterMeta: { displayName: 'alice' }, backChannelAccessId: 'bc-l' } });
    arrive({ endpoint: p.endpoint, bc: 'bc-l', inviteEventId: legacy.id, username: 'alice', time: 5000 });
    const p2 = person('bob');
    const legacy2 = bridge.add({ time: 2, streamIds: [SCOPE], type: 'consent/request-cmc', content: { requesterMeta: { displayName: 'alice' }, backChannelAccessId: 'bc-m' } });
    arrive({ endpoint: p2.endpoint, bc: 'bc-m', inviteEventId: legacy2.id, username: 'bob', time: 5001 });
    await t.inboxTick();
    assert.ok(await getCredentialEvent(KEY('alice')) != null);
    assert.equal(await getCredentialEvent(KEY('bob')), null);
  });

  // ---- replay order ---- //

  it('[CMRA] replay: accept, revoke notice, newer accept, older accept', async () => {
    const a1 = await connect('alice', 5000, 't1', 'bc-a');
    await t.inboxTick();
    // the person revokes: notice, grant gone
    a1.grant.state = 'gone';
    bridge.add({ time: 5100, streamIds: [':_cmc:inbox'], type: REVOKE, content: { backChannelAccessId: 'bc-a', inviteEventId: a1.inviteEventId, scopeStreamId: SCOPE } });
    clock += 1000_000;
    await t.inboxTick();
    assert.equal(await getCredentialEvent(KEY('alice')), null, 'torn down');
    assert.equal(calls.revoked.length, 1);
    // reconnect: newer accept on the same (healed) back-channel
    const p2 = person('alice', 't2');
    const inv2 = await invite('alice', 'bc-a');
    const a2 = arrive({ endpoint: p2.endpoint, bc: 'bc-a', inviteEventId: inv2, username: 'alice', time: 5200 });
    await t.inboxTick();
    const rec = (await getCredentialEvent(KEY('alice')))!;
    assert.equal(rec.apiEndpoint, p2.endpoint);
    assert.equal((rec.clientData.hdsCmc as any).generation, a2.id);
    // the older accept replayed (say its grant were still live): never replaces the newer one
    a1.grant.state = 'live';
    const ctx = await t.ctx();
    const { processAccept } = await import('../src/cmc/accept.ts');
    assert.equal(await processAccept(ctx, a1.arrival), 'skip', 'older never replaces newer');
    assert.equal((await getCredentialEvent(KEY('alice')))!.apiEndpoint, p2.endpoint);
    assert.equal(await processAccept(ctx, a2), 'done', 'same generation: idempotent');
    assert.deepEqual(calls.accepted.map(c => c.replaced), [false, false], 'a reconnect after teardown is fresh');
  });

  it('[CMRB] same-person re-accept swaps the credential, sends no revoke, no onRevoked', async () => {
    const a1 = await connect('alice', 5000, 't1', 'bc-a');
    await t.inboxTick();
    const p2 = person('alice', 't2');
    const inv2 = await invite('alice', 'bc-a');
    const a2 = arrive({ endpoint: p2.endpoint, bc: 'bc-a', inviteEventId: inv2, username: 'alice', time: 5300 });
    await t.inboxTick();
    const cred = (await getCredentialEvent(KEY('alice')))!;
    assert.equal(cred.apiEndpoint, p2.endpoint);
    assert.equal((cred.clientData.hdsCmc as any).generation, a2.id);
    assert.equal(revokesSent().length, 0);
    assert.equal(calls.revoked.length, 0);
    assert.deepEqual(calls.accepted.map(c => c.replaced), [false, true]);
    assert.equal(a1.grant.state, 'live', 'the superseded grant is left to the core');
    assert.equal(bridge.ofType('credentials/pryv-api-endpoint').length, 1);
  });

  // ---- inbox cursor ---- //

  it('[CMIC] cursor lag, ascending pages, overlap dedup, persisted state', async () => {
    const a = await connect('alice', 9850);
    await connect('bob', 9890); // inside the 120 s lag (toTime = 9880)
    await t.inboxTick();
    assert.ok(await getCredentialEvent(KEY('alice')) != null);
    assert.equal(await getCredentialEvent(KEY('bob')), null, 'not read yet: inside the lag');
    const state = bridge.ofType('sync-status/bridge').find(e => e.streamIds.includes('main-cmc'))!;
    assert.deepEqual({ cursor: state.content.cursor, overlapIds: state.content.overlapIds }, { cursor: 9850, overlapIds: [a.arrival.id] });
    clock += 60_000;
    calls.accepted.length = 0;
    await t.inboxTick();
    assert.ok(await getCredentialEvent(KEY('bob')) != null);
    assert.deepEqual(calls.accepted.map(c => c.userKey), [KEY('bob')], 'alice (at the cursor) not processed again');
    assert.equal(cmcRel.health().inboxLagS, 10060 - 9890);
  });

  it('[CMID] more than one page is read in time order', async () => {
    const ctx = await t.ctx();
    const { PAGE_LIMIT } = await import('../src/cmc/inbox.ts');
    for (let i = 0; i < PAGE_LIMIT + 5; i++) {
      bridge.add({ time: 1000 + i, streamIds: [':_cmc:inbox'], type: REVOKE, content: { backChannelAccessId: 'none-' + i } });
    }
    const reads: number[] = [];
    const realApi = bridge.api.bind(bridge);
    bridge.api = async (cs: any[]) => {
      if (cs[0].method === 'events.get' && cs[0].params.streams[0] === ':_cmc:inbox') reads.push(cs[0].params.fromTime);
      return realApi(cs);
    };
    await t.inboxTick();
    assert.deepEqual(reads, [0, 1000 + PAGE_LIMIT - 1], 'the second page starts at the first one\'s last time');
    assert.equal(ctx.seen.cursor, 1000 + PAGE_LIMIT + 4);
  });

  /** Counts the writes of the inbox cursor event (`main-cmc`) from now on. */
  function countCursorWrites (): { n: number } {
    const w = { n: 0 };
    const realApi = bridge.api.bind(bridge);
    bridge.api = async (cs: any[]) => {
      for (const c of cs) {
        if (c.method === 'events.create' && c.params.streamIds?.includes('main-cmc')) w.n++;
        if (c.method === 'events.update' && c.params.update?.content?.cursor != null) w.n++;
      }
      return realApi(cs);
    };
    return w;
  }
  const cursorState = () => bridge.ofType('sync-status/bridge').find(e => e.streamIds.includes('main-cmc'))?.content;

  it('[CMIH] an idle inbox persists its cursor on the first tick, then advances it at most once per EMPTY_ADVANCE_S', async () => {
    const { EMPTY_ADVANCE_S } = await import('../src/cmc/inbox.ts');
    const w = countCursorWrites();
    await t.inboxTick();
    assert.equal(cursorState()?.cursor, 10000 - 120, 'first idle tick: cursor written at toTime');
    assert.equal(w.n, 1);
    clock += 60_000;
    await t.inboxTick();
    assert.equal(w.n, 1, 'no rewrite inside the throttle');
    assert.equal(cmcRel.health().inboxLagS, 120, 'health reads the window as read up to toTime');
    clock += EMPTY_ADVANCE_S * 1000;
    await t.inboxTick();
    assert.equal(w.n, 2);
    assert.equal(cursorState()?.cursor, 10060 + EMPTY_ADVANCE_S - 120);
  });

  it('[CMII] after an arrival, quiet ticks leave the cursor event alone; it then moves past the arrival without reprocessing it', async () => {
    const { EMPTY_ADVANCE_S } = await import('../src/cmc/inbox.ts');
    await connect('alice', 9850);
    await t.inboxTick();
    assert.equal(calls.accepted.length, 1);
    const w = countCursorWrites();
    clock += 60_000;
    await t.inboxTick();
    assert.equal(w.n, 0, 'the arrival at the cursor is read back, the state is unchanged');
    clock += EMPTY_ADVANCE_S * 1000;
    await t.inboxTick();
    assert.equal(w.n, 1);
    assert.deepEqual(cursorState(), { ...cursorState(), cursor: 10060 + EMPTY_ADVANCE_S - 120, overlapIds: [] });
    assert.equal(calls.accepted.length, 1, 'not processed again');
  });

  it('[CMIE] unknown grant state goes to the retry list; the cursor still advances; retried later', async () => {
    const a = await connect('alice', 5000);
    await connect('bob', 5001);
    a.grant.state = 'unknown';
    await t.inboxTick();
    assert.equal(await getCredentialEvent(KEY('alice')), null);
    assert.ok(await getCredentialEvent(KEY('bob')) != null, 'one unreachable core does not stall the others');
    let state = bridge.ofType('sync-status/bridge').find(e => e.streamIds.includes('main-cmc'))!.content;
    assert.equal(state.cursor, 5001);
    assert.deepEqual(state.retry.map((r: any) => [r.id, r.attempts]), [[a.arrival.id, 1]]);
    assert.ok(telemetry.errors.includes('cmc_inbox_retry'));
    a.grant.state = 'live';
    await t.inboxTick();
    assert.equal(await getCredentialEvent(KEY('alice')), null, 'not before its backoff');
    clock += 31_000;
    await t.inboxTick();
    assert.ok(await getCredentialEvent(KEY('alice')) != null);
    state = bridge.ofType('sync-status/bridge').find(e => e.streamIds.includes('main-cmc'))!.content;
    assert.deepEqual(state.retry, []);
  });

  it('[CMIF] first run starts at inbox.initialCursor', async () => {
    make({ inbox: { initialCursor: 6000 } });
    await connect('alice', 5000);
    await connect('bob', 7000);
    await t.inboxTick();
    assert.equal(await getCredentialEvent(KEY('alice')), null);
    assert.ok(await getCredentialEvent(KEY('bob')) != null);
  });

  // ---- revocation ---- //

  it('[CMVA] revoke notices are hints: superseded ignored, scope-only notice confirmed per grant', async () => {
    const a = await connect('alice', 5000, 't1', 'bc-a');
    await connect('bob', 5001, 't1', 'bc-b');
    await t.inboxTick();
    // superseded: ignored even with the grant gone
    a.grant.state = 'gone';
    bridge.add({ time: 5100, streamIds: [':_cmc:inbox'], type: REVOKE, content: { backChannelAccessId: 'bc-a', superseded: 'relationship-re-established' } });
    clock += 200_000;
    await t.inboxTick();
    assert.ok(await getCredentialEvent(KEY('alice')) != null, 'superseded notice ends nothing');
    // an old peer's notice names the scope only: every relationship is a candidate, only the gone one ends
    bridge.add({ time: 5200, streamIds: [':_cmc:inbox'], type: REVOKE, content: { scopeStreamId: SCOPE } });
    clock += 200_000;
    await t.inboxTick();
    assert.equal(await getCredentialEvent(KEY('alice')), null);
    assert.ok(await getCredentialEvent(KEY('bob')) != null, 'live grant kept');
    assert.deepEqual(calls.revoked.map(r => [r.userKey, r.reason]), [[KEY('alice'), 'grant-gone']]);
    assert.ok(telemetry.errors.includes('cmc_revoke_confirmed'));
  });

  it('[CMVB] a notice for a live grant changes nothing; unknown goes to retry', async () => {
    const a = await connect('alice', 5000, 't1', 'bc-a');
    await t.inboxTick();
    bridge.add({ time: 5100, streamIds: [':_cmc:inbox'], type: REVOKE, content: { backChannelAccessId: 'bc-a' } });
    clock += 200_000;
    await t.inboxTick();
    assert.ok(await getCredentialEvent(KEY('alice')) != null, 'live: ignored');
    bridge.add({ time: 5200, streamIds: [':_cmc:inbox'], type: REVOKE, content: { backChannelAccessId: 'bc-a' } });
    a.grant.state = 'unknown';
    clock += 200_000;
    await t.inboxTick();
    assert.ok(await getCredentialEvent(KEY('alice')) != null);
    const state = bridge.ofType('sync-status/bridge').find(e => e.streamIds.includes('main-cmc'))!.content;
    assert.equal(state.retry.length, 1);
    assert.equal(calls.revoked.length, 0);
  });

  it('[CMVC] onRevoked throwing keeps the record live; reconciliation retries', async () => {
    const a = await connect('alice', 5000);
    await t.inboxTick();
    let fail = true;
    hooks.onRevoked = async (rel, reason) => {
      if (fail) throw new Error('queue down');
      calls.revoked.push({ userKey: rel.userKey, reason });
    };
    a.grant.state = 'gone';
    assert.equal(await cmcRel.ensureLive(KEY('alice')), false);
    assert.ok(await getCredentialEvent(KEY('alice')) != null, 'record kept');
    fail = false;
    await t.reconcileOne(KEY('alice'));
    assert.equal(await getCredentialEvent(KEY('alice')), null);
    assert.equal(calls.revoked.length, 1);
  });

  it('[CMVD] lease owner token, generation-checked teardown', async () => {
    const a = await connect('alice', 5000, 't1', 'bc-a');
    await t.inboxTick();
    const ctx = await t.ctx();
    // a holder whose lease expired can never release its successor's
    const k = 'cmc:rel:' + KEY('alice');
    const tok = await cacheLock(k, 1000);
    assert.equal(await cacheLock(k, 1000), null);
    assert.equal(await cacheUnlock(k, 'not-the-owner'), false);
    assert.equal((await withLease(ctx, KEY('alice'), async () => 1)).busy, true);
    assert.equal(await cacheUnlock(k, tok!), true);
    // teardown confirmed for generation G does nothing once a newer accept is stored
    const g1 = a.arrival.id;
    const p2 = person('alice', 't2');
    const inv2 = await invite('alice', 'bc-a');
    arrive({ endpoint: p2.endpoint, bc: 'bc-a', inviteEventId: inv2, username: 'alice', time: 5300 });
    await t.inboxTick();
    const r = await withLease(ctx, KEY('alice'), () => teardownLocked(ctx, KEY('alice'), g1, 'grant-gone'));
    assert.deepEqual(r, { busy: false, value: 'stale' });
    assert.ok(await getCredentialEvent(KEY('alice')) != null);
    assert.equal(calls.revoked.length, 0);
  });

  it('[CMVE] revoke(): disconnected status, CMC revoke by accessId, teardown; firstConnectAllowed', async () => {
    hooks.statusStreamId = 'sync-status-reader';
    make();
    const a = await connect('alice', 5000, 't1', 'bc-a');
    await t.inboxTick();
    assert.equal(await cmcRel.firstConnectAllowed(KEY('alice')), false, 'live grant');
    a.grant.state = 'unknown';
    assert.equal(await cmcRel.firstConnectAllowed(KEY('alice')), false, 'unknown fails closed');
    a.grant.state = 'live';
    await cmcRel.revoke(KEY('alice'));
    assert.deepEqual(revokesSent().map(e => e.content), [{ accessId: 'bc-a' }]);
    assert.equal(await getCredentialEvent(KEY('alice')), null);
    assert.deepEqual(calls.revoked.map(r => r.reason), ['revoked-by-bridge']);
    const status = a.grant.events.find(e => e.type === 'sync-status/connector-v1')!;
    assert.equal(status.content.status, 'disconnected');
    assert.equal(await cmcRel.firstConnectAllowed(KEY('alice')), true, 'nothing stored');
    // a gone grant is torn down by the first-connect guard
    const b = await connect('bob', 5100);
    await t.inboxTick();
    b.grant.state = 'gone';
    assert.equal(await cmcRel.firstConnectAllowed(KEY('bob')), true);
    assert.equal(await getCredentialEvent(KEY('bob')), null);
    assert.equal(await cmcRel.reportAccessError(KEY('bob'), new Error('x')), 'unknown', 'no record any more');
  });

  // ---- scope ---- //

  it('[CMPA] widen set algebra and level conflicts', () => {
    // access-info also lists the platform streams the core adds to every access (seen live on demo)
    const cur = [{ streamId: ':_system:account', level: 'none' }, { streamId: 'inbox', level: 'read' }, { streamId: ':_audit:access-a1', level: 'read' },
      { streamId: 'values', level: 'create-only' }, { streamId: ':_cmc:inbox', level: 'create-only' }];
    assert.deepEqual(unionPermissions(cur, [{ streamId: 'dialogue', level: 'contribute' }, { streamId: 'inbox', level: 'read' }]), [
      { streamId: 'inbox', level: 'read' }, { streamId: 'values', level: 'create-only' }, { streamId: 'dialogue', level: 'contribute' }
    ]);
    assert.deepEqual(unionPermissions(cur, [{ streamId: 'inbox', level: 'contribute' }])[0], { streamId: 'inbox', level: 'contribute' });
    assert.deepEqual(unionPermissions(cur, [{ streamId: 'values', level: 'manage' }])[1], { streamId: 'values', level: 'manage' });
    assert.deepEqual(dataPermissions([...cur, { feature: 'selfRevoke', setting: 'forbidden' }]), [
      { streamId: 'inbox', level: 'read' }, { streamId: 'values', level: 'create-only' }, { feature: 'selfRevoke', setting: 'forbidden' }
    ]);
    assert.throws(() => unionPermissions(cur, [{ streamId: 'values', level: 'read' }]), (e: any) => e.id === 'scope-level-conflict');
    assert.throws(() => unionPermissions(cur, [{ streamId: 'inbox', level: 'create-only' }]), (e: any) => e.id === 'scope-level-conflict');
    assert.throws(() => unionPermissions([{ streamId: 's', level: 'manage' }], [{ streamId: 's', level: 'read' }]), (e: any) => e.id === 'scope-level-conflict');
    assert.equal(levelContains('contribute', 'create-only'), true);
    assert.equal(levelContains('read', 'create-only'), false);
    assert.equal(levelContains('manage', 'manage'), false);
  });

  it('[CMPB] widen sends the full set from access-info; one open request; answer poll', async () => {
    const a = await connect('alice');
    await t.inboxTick();
    const rel = (await cmcRel.get(KEY('alice')))!;
    a.grant.info.permissions.push({ streamId: 'added-by-person', level: 'read' });
    const pending = await rel.scope.widen([{ streamId: 'hds-reader-dialogue', level: 'contribute' }], { expiresInSeconds: 100 });
    const sent = bridge.ofType('consent/scope-request-cmc')[0]!;
    assert.deepEqual(sent.streamIds, [rel.record.collectorStreamId]);
    assert.deepEqual(sent.content.newPermissions, [
      { streamId: 'hds-reader-inbox', level: 'read' }, { streamId: 'added-by-person', level: 'read' }, { streamId: 'hds-reader-dialogue', level: 'contribute' }
    ]);
    assert.equal(pending.remoteScopeRequestEventId, 'remote-' + sent.id);
    assert.equal(pending.expires, 10100);
    await assert.rejects(() => rel.scope.replace([{ streamId: 'x', level: 'read' }]), (e: any) => e.id === 'scope-request-open');
    assert.ok(telemetry.errors.includes('cmc_scope_request_open'));
    assert.equal(bridge.ofType('consent/scope-request-cmc').length, 1);
    assert.deepEqual((await cmcRel.get(KEY('alice')))!.scope.pending(), pending);
    // no answer yet
    await t.scopeTick();
    assert.equal(calls.answer.length, 0);
    // the person accepts: the answer arrives on the collectors stream, the grant changes
    bridge.add({ time: 6000, streamIds: [rel.record.collectorStreamId], type: 'consent/scope-update-cmc', content: { from: { username: 'alice' }, scopeRequestEventId: 'remote-' + sent.id, accept: true } });
    a.grant.info.permissions = [...sent.content.newPermissions];
    await t.scopeTick();
    assert.equal(calls.answer.length, 1);
    assert.equal(calls.answer[0].answer, 'accepted');
    const after = (await cmcRel.get(KEY('alice')))!;
    assert.equal(after.record.pendingScopeRequest, null);
    assert.equal(after.record.grantedPermissions.length, 3);
    // supersede and expiry
    await after.scope.replace([{ streamId: 'hds-reader-inbox', level: 'read' }], { expiresInSeconds: 10 });
    await assert.rejects(() => after.scope.replace([{ streamId: 'x', level: 'read' }]), (e: any) => e.id === 'scope-request-open');
    await (await cmcRel.get(KEY('alice')))!.scope.replace([{ streamId: 'x', level: 'read' }], { supersede: true });
    clock += 31 * 24 * 3600 * 1000;
    await t.scopeTick();
    assert.equal(calls.answer.at(-1).answer, 'expired');
  });

  it('[CMPC] a delivery failure records nothing; widen refuses a level conflict before sending', async () => {
    await connect('alice');
    await t.inboxTick();
    const rel = (await cmcRel.get(KEY('alice')))!;
    await assert.rejects(() => rel.scope.widen([{ streamId: 'hds-reader-inbox', level: 'create-only' }]), (e: any) => e.id === 'scope-level-conflict');
    assert.equal(bridge.ofType('consent/scope-request-cmc').length, 0);
    bridge.scopeRequest = 'failed';
    await assert.rejects(() => rel.scope.widen([{ streamId: 'more', level: 'read' }]));
    assert.equal((await cmcRel.get(KEY('alice')))!.record.pendingScopeRequest, null);
  });

  // ---- loops ---- //

  it('[CMLA] start needs cmc:enabled; on the scheduler it runs the inbox at once; stop clears the loops', async () => {
    await assert.rejects(() => cmcRel.start(), /cmc:enabled/);
    (await getConfig()).set('cmc:enabled', true);
    try {
      await connect('alice');
      make({ isScheduler: () => true });
      await cmcRel.start();
      for (let i = 0; i < 50 && calls.accepted.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(calls.accepted.length, 1);
      await cmcRel.stop();
      const n = bridge.calls.length;
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(bridge.calls.length, n, 'nothing runs after stop');
    } finally {
      (await getConfig()).set('cmc:enabled', false);
    }
  });

  // ---- webhook, reconciliation, dispatch ---- //

  describe('[CMW] webhooks', function () {
    let app: express.Application;
    beforeEach(async () => {
      (await getConfig()).set('cmc:enabled', true);
      hooks.webhookScopes = () => ({ inbox: { kind: 'events', query: { streams: ['hds-reader-inbox'] } } });
      make({ webhooks: { enabled: true, publicBaseUrl: 'https://bridge.datasafe.test/' }, isScheduler: () => false });
      app = express();
      await cmcRel.start(app);
    });
    afterEach(async () => { (await getConfig()).set('cmc:enabled', false); });

    it('[CMWA] created with the grant at accept; delivery dispatches onChange with the scope keys; unknown hookId 404', async () => {
      const a = await connect('alice');
      await t.inboxTick();
      const rec = (await cmcRel.get(KEY('alice')))!.record;
      const wh = a.grant.webhooks.get(rec.webhook!.id)!;
      assert.equal(wh.url, `https://bridge.datasafe.test/cmc/hook/${rec.webhook!.hookId}`);
      assert.deepEqual(wh.scopes, { inbox: { kind: 'events', query: { streams: ['hds-reader-inbox'] } } });
      await request(app).post(`/cmc/hook/${rec.webhook!.hookId}`).send({ messages: ['inbox'], meta: {} }).expect(200);
      await new Promise(resolve => setImmediate(resolve));
      for (let i = 0; i < 20 && calls.change.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.deepEqual(calls.change.map(c => [c.userKey, c.reason, c.scopeKeys, c.modifiedSince]), [[KEY('alice'), 'webhook', ['inbox'], null]]);
      await request(app).post('/cmc/hook/' + 'f'.repeat(32)).send({}).expect(404);
      await request(app).post('/cmc/hook/not-an-id').send({}).expect(404);
      assert.equal(cmcRel.health().scope.healthy, true, 'scope probe ran at start');
    });

    it('[CMWB] negative cache: an unknown hookId rebuilds the map at most once per minute', async () => {
      await connect('alice');
      await t.inboxTick();
      const rec = (await cmcRel.get(KEY('alice')))!.record;
      await cacheDel('cmc:hook:' + rec.webhook!.hookId);
      let lists = 0;
      const realApi = bridge.api.bind(bridge);
      bridge.api = async (cs: any[]) => {
        if (cs[0].method === 'events.get' && cs[0].params.streams[0] === 'main-users') lists++;
        return realApi(cs);
      };
      await request(app).post(`/cmc/hook/${rec.webhook!.hookId}`).send({ messages: [] }).expect(200);
      assert.equal(lists, 1, 'rebuilt from the records');
      await request(app).post('/cmc/hook/' + 'a'.repeat(32)).send({}).expect(404);
      await request(app).post('/cmc/hook/' + 'a'.repeat(32)).send({}).expect(404);
      await request(app).post('/cmc/hook/' + 'b'.repeat(32)).send({}).expect(404);
      assert.equal(lists, 1, 'no rebuild within the minute');
    });

    it('[CMWC] reconciliation reactivates an inactive webhook and recreates a missing one, then polls', async () => {
      const a = await connect('alice');
      await t.inboxTick();
      const first = (await cmcRel.get(KEY('alice')))!.record.webhook!;
      a.grant.webhooks.get(first.id)!.state = 'inactive';
      telemetry.errors.length = 0;
      await t.reconcileOne(KEY('alice'));
      assert.equal(a.grant.webhooks.get(first.id)!.state, 'active');
      assert.deepEqual(telemetry.errors, ['cmc_webhook_reactivated']);
      a.grant.webhooks.clear();
      await t.reconcileOne(KEY('alice'));
      const second = (await cmcRel.get(KEY('alice')))!.record.webhook!;
      assert.notEqual(second.hookId, first.hookId);
      assert.ok(a.grant.webhooks.has(second.id));
      assert.ok(telemetry.errors.includes('cmc_webhook_recreated'));
      assert.deepEqual(calls.change.map(c => [c.reason, c.modifiedSince]), [['poll', null], ['poll', 10000 - 60]]);
      assert.equal((await cmcRel.get(KEY('alice')))!.record.lastDispatchAt, 10000, 'kept on the relationship record');
      assert.equal(bridge.ofType('sync-status/bridge').filter(e => !e.streamIds.includes('main-cmc')).length, 0,
        'the plugin\'s state event is never written by the module');
    });

    it('[CMWD] dispatch coalesces on a busy lease; the holder runs once more', async () => {
      await connect('alice');
      await t.inboxTick();
      const ctx = await t.ctx();
      const { dispatch } = await import('../src/cmc/webhook.ts');
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let n = 0;
      hooks.onChange = async (rel, c) => {
        calls.change.push({ userKey: rel.userKey, ...c });
        if (n++ === 0) await gate;
      };
      const first = dispatch(ctx, KEY('alice'), 'webhook', ['inbox']);
      await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(await dispatch(ctx, KEY('alice'), 'webhook', ['inbox']), 'coalesced');
      release();
      assert.equal(await first, 'done');
      assert.deepEqual(calls.change.map(c => c.reason), ['webhook', 'again']);
      hooks.onChange = async () => { throw new Error('queue down'); };
      const before = (await cmcRel.get(KEY('alice')))!.record.lastDispatchAt;
      clock += 5000;
      await dispatch(ctx, KEY('alice'), 'poll');
      assert.equal((await cmcRel.get(KEY('alice')))!.record.lastDispatchAt, before, 'written only after a successful dispatch');
      assert.ok(telemetry.errors.includes('cmc_dispatch_coalesced'));
    });

    it('[CMWF] lastDispatchAt is saved at most every DISPATCH_SAVE_EVERY_S; modifiedSince follows the saved value', async () => {
      await connect('alice');
      await t.inboxTick();
      const ctx = await t.ctx();
      const { dispatch, DISPATCH_SAVE_EVERY_S } = await import('../src/cmc/webhook.ts');
      await dispatch(ctx, KEY('alice'), 'poll');
      assert.equal((await cmcRel.get(KEY('alice')))!.record.lastDispatchAt, 10000, 'the first dispatch saves');
      clock += 300_000;
      await dispatch(ctx, KEY('alice'), 'poll');
      assert.equal((await cmcRel.get(KEY('alice')))!.record.lastDispatchAt, 10000, 'not rewritten 300 s later');
      clock += DISPATCH_SAVE_EVERY_S * 1000;
      await dispatch(ctx, KEY('alice'), 'poll');
      assert.equal((await cmcRel.get(KEY('alice')))!.record.lastDispatchAt, 10000 + 300 + DISPATCH_SAVE_EVERY_S, 'saved again after the interval');
      assert.deepEqual(calls.change.map(c => c.modifiedSince), [null, 10000 - 60, 10000 - 60]);
    });

    it('[CMWE] onAccepted failure is retried by reconciliation, not by re-processing the accept', async () => {
      let fail = true;
      hooks.onAccepted = async (rel, c) => {
        if (fail) throw new Error('later');
        calls.accepted.push({ userKey: rel.userKey, ...c });
      };
      await connect('alice');
      await t.inboxTick();
      assert.equal((await cmcRel.get(KEY('alice')))!.record.acceptHookDone, false);
      fail = false;
      await t.reconcileOne(KEY('alice'));
      assert.deepEqual(calls.accepted.map(c => c.replaced), [false]);
      assert.equal((await cmcRel.get(KEY('alice')))!.record.acceptHookDone, true);
    });
  });
});
