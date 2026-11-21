import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import boiler from 'dev-boiler';
import express from 'express';
import request from 'supertest';
import { pryv, cmc } from 'hds-lib';
import initBoiler from '../src/initBoiler.ts';
import { _initForTests } from '../src/lib/bridgeAccount.ts';
import { getCredentialEvent } from '../src/methods/user.ts';
import { setTelemetryHolderForTests } from '../src/lib/observability.ts';
import { createCmcRelationships, _testInternals } from '../src/cmc/index.ts';
import type { CmcHooks, CmcRelationships } from '../src/cmc/types.ts';
import { bridgeIsConfigured } from './helpers/testServer.ts';

/**
 * CMC relationship module against a real core (plan 129 WP3, DESIGN.md §11 "Live").
 *
 * Runs when `CMC_LIVE=1` or a bridge account is configured (`bridgeApiEndPoint` in
 * localConfig.yml), and only on a test platform (`service:serviceInfoURL` on demo or a local
 * core): it creates throwaway accounts there, a bridge account and three people, so it never
 * uses the configured bridge account itself. Skipped otherwise.
 *
 *   CMC_LIVE=1 npm test -- --grep LCM     (or: CMC_LIVE=1 node node_modules/mocha/bin/mocha.js
 *                                           --require tests/setupConfig.ts tests/cmcLive.test.ts)
 *
 * The loops are driven one tick at a time, with no inbox lag. Webhooks are created against a
 * `.invalid` base URL: the core accepts it and every delivery fails at DNS, so nothing leaves
 * the platform; delivery is exercised by posting to the mounted route. Never logs an
 * apiEndpoint or a token.
 */

const { getConfig } = boiler;
const MAIN = 'bridge';
const APP_CODE = 'hds-bridge-reader';
const SCOPE = cmc.appScope(APP_CODE);
const PERSON_SCOPE = cmc.appScope('hds-patient');
const INBOX = 'cmc-live-inbox';
const EXTRA = 'cmc-live-extra';
const ACCEPT = 'consent/accept-cmc';
const REVOKE = 'consent/revoke-cmc';
const PUBLIC_BASE = 'https://lib-bridge-cmc-live.invalid';
const TEST_PLATFORM = /demo|backloop\.dev|localhost|127\.0\.0\.1/;

interface Person { username: string, conn: InstanceType<typeof pryv.Connection> }

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Poll `fn` until it returns something truthy. */
async function until<T> (what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(1000);
  }
}

async function liveEnabled (): Promise<string | null> {
  if (process.env.CMC_LIVE !== '1' && !(await bridgeIsConfigured())) return null;
  const url = (await getConfig()).get<string>('service:serviceInfoURL');
  return typeof url === 'string' && TEST_PLATFORM.test(url) ? url : null;
}

/** Every throwaway account this run created, deleted in `after`. */
const created: Person[] = [];

async function newAccount (service: InstanceType<typeof pryv.Service>, prefix: string, appId: string): Promise<Person> {
  const username = prefix + crypto.randomBytes(4).toString('hex');
  const password = crypto.randomBytes(18).toString('base64url');
  await (service as any).createUser({ username, password, email: username + '@example.com', hosting: 'auto', appId, language: 'en' });
  const conn = await service.login(username, password, appId + '-cmc-live');
  created.push({ username, conn });
  return { username, conn };
}

/**
 * Self-service account deletion (`auth.delete`, allowed with the personal token on demo):
 * `DELETE /users/<username>` at the root of the account's home core, which the register names.
 */
async function deleteAccount (service: InstanceType<typeof pryv.Service>, p: Person): Promise<void> {
  const register = (await service.info()).register;
  const res = await fetch(register.replace(/\/?$/, '/') + encodeURIComponent(p.username) + '/server', { method: 'POST', headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`home core lookup: HTTP ${res.status}`);
  const server: string = (await res.json()).server;
  const del = await fetch(server.replace(/\/?$/, '/') + 'users/' + encodeURIComponent(p.username), { method: 'DELETE', headers: { Authorization: (p.conn as any).token } });
  if (!del.ok) throw new Error(`HTTP ${del.status}`);
}

async function api (conn: { api: (c: any[]) => Promise<any> }, method: string, params: any): Promise<any> {
  const res = await conn.api([{ method, params }]);
  if (res?.[0]?.error != null) throw new Error(`${method}: ${res[0].error.id}`);
  return res[0];
}

/** A person on the platform, with the app scope the HDS webapp accepts under and two data streams. */
async function newPerson (service: InstanceType<typeof pryv.Service>, appId: string): Promise<Person> {
  const p = await newAccount(service, 'cmcpers', appId);
  for (const s of [{ id: PERSON_SCOPE, parentId: ':_cmc:apps', name: 'hds-patient' }, { id: INBOX, name: 'Inbox' }, { id: EXTRA, name: 'Extra' }]) {
    await api(p.conn, 'streams.create', s);
  }
  return p;
}

describe('[LCM] CMC relationship module, live core', function () {
  this.timeout(180_000);
  let restore: (() => void) | null = null;
  let service: InstanceType<typeof pryv.Service>;
  let bridge: InstanceType<typeof pryv.Connection>;
  let alice: Person;
  let bob: Person;
  let carol: Person;
  let hostPattern: string;
  let cmcRel: CmcRelationships;
  let t: ReturnType<typeof _testInternals>;
  let app: express.Application;
  const errors: string[] = [];
  const calls = { accepted: [] as any[], revoked: [] as any[], change: [] as any[], answer: [] as any[] };
  let aliceKey: string;
  let aliceGrantAccessId: string;

  before(async function () {
    initBoiler(`bridge-cmc-live:${process.pid}`);
    const serviceInfoURL = await liveEnabled();
    if (serviceInfoURL == null) this.skip();
    const appId = (await getConfig()).get<string>('service:appId');
    service = new pryv.Service(serviceInfoURL);

    // a throwaway bridge account, provisioned like a real one (bridge-mira's provisionTestBridge)
    const owner = await newAccount(service, 'cmcbrtest', appId);
    for (const s of [{ id: MAIN, name: 'Bridge' }, ...['users', 'users-active', 'errors', 'cmc'].map(x => ({ id: `${MAIN}-${x}`, parentId: MAIN, name: x }))]) {
      await api(owner.conn, 'streams.create', s);
    }
    const access = await api(owner.conn, 'accesses.create', {
      type: 'app',
      name: appId,
      permissions: [
        { streamId: MAIN, level: 'manage' },
        { streamId: ':_cmc:inbox', level: 'manage' },
        { streamId: ':_cmc:apps', level: 'manage' }
      ]
    });
    bridge = new pryv.Connection(access.access.apiEndpoint);
    restore = _initForTests(bridge, MAIN);

    alice = await newPerson(service, appId);
    bob = await newPerson(service, appId);
    carol = await newPerson(service, appId);
    // the platform's domain (last two labels), as `service:apiEndpointHostPattern` would hold it
    hostPattern = '(^|\\.)' + new URL(alice.conn.apiEndpoint).hostname.split('.').slice(-2).join('\\.');

    setTelemetryHolderForTests({ obs: { recordCall: () => {}, recordError: (c: string) => { errors.push(c); } } as any });
    const hooks: CmcHooks = {
      requestedPermissions: () => [{ streamId: INBOX, level: 'read' }],
      webhookScopes: () => ({ inbox: { kind: 'events', query: { streams: [INBOX] } } }),
      onAccepted: async (rel, c) => { calls.accepted.push({ userKey: rel.userKey, generation: rel.record.generation, ...c }); },
      onRevoked: async (rel, reason) => { calls.revoked.push({ userKey: rel.userKey, generation: rel.record.generation, reason }); },
      onChange: async (rel, c) => { calls.change.push({ userKey: rel.userKey, ...c }); },
      onScopeAnswer: async (rel, a) => { calls.answer.push({ userKey: rel.userKey, ...a }); }
    };
    cmcRel = createCmcRelationships({
      hooks,
      apiEndpointHostPattern: hostPattern,
      patientAppBaseUrl: 'https://demo-app.datasafe.dev',
      inbox: { lagS: 0 },
      webhooks: { enabled: true, publicBaseUrl: PUBLIC_BASE },
      isScheduler: () => false // no timers: the test drives each loop
    });
    t = _testInternals(cmcRel);
    (await getConfig()).set('cmc:enabled', true);
    app = express();
    await cmcRel.start(app);
  });

  after(async () => {
    if (cmcRel != null) await cmcRel.stop();
    (await getConfig()).set('cmc:enabled', false);
    setTelemetryHolderForTests(null);
    restore?.();
    const failed: string[] = [];
    for (const p of created.splice(0)) {
      try { await deleteAccount(service, p); } catch (e) { failed.push(`${p.username} (${(e as Error).message})`); }
    }
    if (failed.length > 0) console.warn(`[LCM] throwaway accounts left on the platform: ${failed.join(', ')}`);
  });

  /** The bridge's inbox arrivals of `type` from `username`. */
  async function arrivals (type: string, username: string): Promise<any[]> {
    const res = await api(bridge, 'events.get', { streams: [':_cmc:inbox'], types: [type], limit: 100 });
    return res.events.filter((e: any) => e.content?.from?.username === username);
  }

  async function personAccept (p: Person, capabilityUrl: string): Promise<any> {
    return await cmc.acceptInvite(p.conn as any, capabilityUrl, { scopeStreamId: PERSON_SCOPE, accessName: 'cmc-live-' + crypto.randomBytes(3).toString('hex') });
  }

  async function accessExists (p: Person, id: string): Promise<boolean> {
    const res = await api(p.conn, 'accesses.get', {});
    return (res.accesses as any[]).some(a => a.id === id);
  }

  it('[LCMA] invite → the person accepts → the inbox tick stores credential + record → onAccepted', async () => {
    const inv = await cmcRel.createInvite({ expectedUsername: alice.username });
    assert.ok(inv.patientUrl.startsWith('https://demo-app.datasafe.dev/?action=invite&capabilityUrl='));
    const accepted = await personAccept(alice, inv.capabilityUrl);
    aliceGrantAccessId = accepted.dataGrantAccessId;
    assert.ok(typeof aliceGrantAccessId === 'string');

    // [V] the core's stamp on the invite trigger keeps requesterMeta.hdsExpectedUsername
    const trigger = (await api(bridge, 'events.getOne', { id: inv.inviteEventId })).event;
    assert.equal(trigger.content.requesterMeta?.hdsExpectedUsername, alice.username);
    assert.notEqual(trigger.content.requesterMeta?.displayName, alice.username, 'the invite never names the invited person as its sender');
    assert.equal(typeof trigger.content.backChannelAccessId, 'string', 'stamped accepted by the core');

    await until('onAccepted', async () => { await t.inboxTick(); return calls.accepted.length > 0; });
    const arrival = (await arrivals(ACCEPT, alice.username))[0];
    aliceKey = cmc.counterpartySlug({ username: alice.username, host: arrival.content.from.host });
    assert.deepEqual(calls.accepted, [{ userKey: aliceKey, generation: arrival.id, replaced: false }]);

    const rel = (await cmcRel.get(aliceKey))!;
    const r = rel.record;
    assert.equal(r.username, alice.username);
    assert.equal(r.relationshipId, trigger.content.backChannelAccessId);
    assert.equal(r.relationshipId, arrival.content.backChannelAccessId);
    assert.equal(r.inviteEventId, inv.inviteEventId);
    assert.equal(r.dataGrantAccessId, aliceGrantAccessId);
    assert.equal(r.collectorStreamId, cmc.collectorStreamUnder(SCOPE, aliceKey));
    assert.deepEqual(r.grantedPermissions, [{ streamId: INBOX, level: 'read' }]);
    assert.equal(r.acceptHookDone, true);
    assert.ok(r.webhook != null, 'webhook created with the data grant');

    const cred = (await getCredentialEvent(aliceKey))!;
    assert.ok(cred.apiEndpoint === arrival.content.grantedAccess.apiEndpoint, 'credential = the grant (not printed)');
    assert.ok(!JSON.stringify(r).includes(new URL(cred.apiEndpoint).username), 'the record holds no token');
    const info = await rel.connection().accessInfo();
    assert.equal(info.user?.username, alice.username);
    assert.equal(await cmcRel.ensureLive(aliceKey), true);
    assert.equal(await cmcRel.firstConnectAllowed(aliceKey), false, 'a live grant blocks a first connect');
    assert.equal((await cmcRel.byRelationshipId(r.relationshipId))?.userKey, aliceKey);

    // a second tick replays nothing
    await t.inboxTick();
    assert.equal(calls.accepted.length, 1);
  });

  it('[LCMS] scope: widen → the person accepts the update → the answer poll refreshes the grant → onScopeAnswer', async () => {
    const rel = (await cmcRel.get(aliceKey))!;
    const pending = await rel.scope.widen([{ streamId: EXTRA, level: 'read' }], { message: { en: 'cmc live test' } });
    assert.deepEqual(pending.permissions, [{ streamId: INBOX, level: 'read' }, { streamId: EXTRA, level: 'read' }]);
    await assert.rejects(rel.scope.widen([{ streamId: EXTRA, level: 'read' }]), (e: any) => e.id === 'scope-request-open');

    const remote = pending.remoteScopeRequestEventId ?? await until('the delivered request', async () => {
      await t.scopeTick();
      return (await cmcRel.get(aliceKey))?.record.pendingScopeRequest?.remoteScopeRequestEventId;
    });
    const res = await cmc.acceptScopeUpdate(alice.conn as any, remote);
    assert.equal(res.dataGrantAccessId, aliceGrantAccessId, 'the grant is updated in place (same access)');

    await until('onScopeAnswer', async () => { await t.scopeTick(); return calls.answer.length > 0; });
    assert.equal(calls.answer[0].answer, 'accepted');
    assert.equal(calls.answer[0].scopeRequestEventId, pending.scopeRequestEventId);
    const after = (await cmcRel.get(aliceKey))!;
    assert.equal(after.record.pendingScopeRequest, null);
    assert.deepEqual(after.record.grantedPermissions, [{ streamId: INBOX, level: 'read' }, { streamId: EXTRA, level: 'read' }]);
    // the stored credential still works and carries the new permission
    const info = await after.connection().accessInfo();
    assert.ok((info.permissions as any[]).some(p => p.streamId === EXTRA && p.level === 'read'));
  });

  it('[LCMW] webhook: created with the grant, reactivated, recreated; a delivery to the route dispatches onChange', async () => {
    const rel = (await cmcRel.get(aliceKey))!;
    const grant = rel.connection();
    const first = rel.record.webhook!;
    const wh = (await api(grant, 'webhooks.getOne', { id: first.id })).webhook;
    assert.equal(wh.url, `${PUBLIC_BASE}/cmc/hook/${first.hookId}`);

    await api(grant, 'webhooks.update', { id: first.id, update: { state: 'inactive' } });
    errors.length = 0;
    await t.reconcileOne(aliceKey);
    assert.equal((await api(grant, 'webhooks.getOne', { id: first.id })).webhook.state, 'active');
    assert.ok(errors.includes('cmc_webhook_reactivated'));

    await api(grant, 'webhooks.delete', { id: first.id });
    await t.reconcileOne(aliceKey);
    const second = (await cmcRel.get(aliceKey))!.record.webhook!;
    assert.notEqual(second.id, first.id);
    assert.ok(errors.includes('cmc_webhook_recreated'));
    assert.equal((await api(grant, 'webhooks.getOne', { id: second.id })).webhook.url, `${PUBLIC_BASE}/cmc/hook/${second.hookId}`);
    assert.ok(calls.change.some(c => c.reason === 'poll'), 'reconciliation polls');

    await request(app).post(`/cmc/hook/${second.hookId}`).send({ messages: ['inbox'] }).expect(200);
    await until('the webhook dispatch', async () => calls.change.some(c => c.reason === 'webhook'), 10_000);
    assert.deepEqual(calls.change.find(c => c.reason === 'webhook').scopeKeys, ['inbox']);
    await request(app).post(`/cmc/hook/${first.hookId}`).send({}).expect(404);
  });

  it('[LCMP] wrong person: an accept by someone else than the expected username is refused, alerted, then revoked', async () => {
    const inv = await cmcRel.createInvite({ expectedUsername: 'cmcnobody' + crypto.randomBytes(3).toString('hex') });
    const accepted = await personAccept(bob, inv.capabilityUrl);
    errors.length = 0;
    await until('the refusal', async () => { await t.inboxTick(); return errors.includes('cmc_accept_wrong_person'); });
    const arrival = (await arrivals(ACCEPT, bob.username))[0];
    const bobKey = cmc.counterpartySlug({ username: bob.username, host: arrival.content.from.host });
    assert.equal(await getCredentialEvent(bobKey), null, 'nothing stored');
    assert.equal(await cmcRel.get(bobKey), null);
    assert.equal(calls.accepted.length, 1);

    const sent = await api(bridge, 'events.get', { streams: [SCOPE], types: ['notification/alert-cmc', REVOKE], limit: 100 });
    const alert = (sent.events as any[]).find(e => e.type === 'notification/alert-cmc' &&
      e.streamIds.includes(cmc.collectorStreamUnder(SCOPE, bobKey)));
    const revoke = (sent.events as any[]).find(e => e.type === REVOKE && e.content?.accessId === arrival.content.backChannelAccessId);
    assert.ok(alert != null, 'value-free alert sent');
    assert.ok(revoke != null, 'revoked by accessId');
    assert.ok(alert.created <= revoke.created, 'alert first, then revoke');
    await until('bob\'s grant to end', async () => !(await accessExists(bob, accepted.dataGrantAccessId)), 60_000);
    await t.inboxTick(); // the core's own revoke notice: no live record matches
    assert.equal(calls.revoked.length, 0);
    assert.ok(await cmcRel.get(aliceKey) != null, 'alice untouched');
  });

  it('[LCMF] a forged accept (capability token, no capabilityId, another invite\'s id) is never stored (B-2026-11-19-7)', async function () {
    const target = await cmcRel.createInvite({});
    const used = await cmcRel.createInvite({});
    // carol holds `used`'s capability URL and writes the accept herself, pointing at `target`
    const cap = new pryv.Connection(used.capabilityUrl);
    const capInfo = await cap.accessInfo();
    const responses = (capInfo.permissions as any[]).map(p => p.streamId).find(s => typeof s === 'string' && s.startsWith(':_cmc:_internal:responses:'));
    assert.ok(responses != null, 'the capability may write its responses stream');
    const own = await api(carol.conn, 'accesses.create', { type: 'app', name: 'cmc-live-forged', permissions: [{ streamId: INBOX, level: 'read' }] });
    const aliceArrival = (await arrivals(ACCEPT, alice.username))[0];
    const created = await cap.api([{
      method: 'events.create',
      params: {
        streamIds: [responses],
        type: ACCEPT,
        content: {
          grantedAccess: { apiEndpoint: own.access.apiEndpoint },
          from: { username: carol.username, host: aliceArrival.content.from.host },
          inviteEventId: target.inviteEventId
        }
      }
    }]);
    const writeError = created?.[0]?.error?.id;
    let mirror: any = null;
    if (writeError == null) {
      mirror = await until('the mirror', async () => (await arrivals(ACCEPT, carol.username))[0], 30_000).catch(() => null);
    }
    const observed = writeError != null
      ? `write refused: ${writeError}`
      : mirror == null
        ? 'no inbox mirror'
        : mirror.content.inviteEventId === target.inviteEventId
          ? 'REPRODUCED: the mirror carries the forged inviteEventId'
          : `mirror inviteEventId ${mirror.content.inviteEventId === used.inviteEventId ? 'is the capability\'s own invite' : 'is ' + String(mirror.content.inviteEventId)}`;
    const meta = await (await fetch(cap.endpoint + 'access-info', { headers: { authorization: cap.token! } })).json() as any;
    const capState = (await cmc.readOffer(used.capabilityUrl)).capabilityState;
    const targetStamped = (await api(bridge, 'events.getOne', { id: target.inviteEventId })).event.content.backChannelAccessId != null;
    this.test!.title += ` [core ${meta?.meta?.apiVersion}; ${observed}; back-channel minted: ${typeof mirror?.content?.backChannelAccessId === 'string'}; ` +
      `the used single-use link afterwards: ${capState}; target invite stamped: ${targetStamped}]`;

    errors.length = 0;
    await t.inboxTick();
    await t.inboxTick();
    const carolKey = cmc.counterpartySlug({ username: carol.username, host: aliceArrival.content.from.host });
    assert.equal(await getCredentialEvent(carolKey), null, 'never stored');
    assert.equal(calls.accepted.length, 1);
    if (mirror != null) assert.ok(errors.includes('cmc_accept_unknown_invite'), `refused as unknown invite (${errors.join(',')})`);
  });

  it('[LCMR] the person revokes → the inbox notice is confirmed gone → onRevoked → credential deleted', async () => {
    // as the HDS webapp does (ContactDetailsDialog): revoke the counterparty access through CMC
    const accesses = (await api(alice.conn, 'accesses.get', {})).accesses as any[];
    const counterparty = accesses.filter(a => a.clientData?.cmc?.role === 'counterparty');
    assert.equal(counterparty.length, 1, 'alice holds one relationship');
    await cmc.revokeAcceptance(alice.conn as any, { scopeStreamId: PERSON_SCOPE, accessId: counterparty[0].id, reason: { en: 'cmc live test' } });

    await until('onRevoked', async () => { await t.inboxTick(); return calls.revoked.length > 0; });
    const record = calls.revoked[0];
    assert.equal(record.userKey, aliceKey);
    assert.equal(record.reason, 'grant-gone');
    assert.equal(await getCredentialEvent(aliceKey), null, 'credential deleted');
    assert.equal(await cmcRel.get(aliceKey), null);
    assert.equal(await cmcRel.ensureLive(aliceKey), false);
    assert.equal(await cmcRel.firstConnectAllowed(aliceKey), true);
    assert.ok(errors.includes('cmc_revoke_confirmed'));
    assert.equal(await accessExists(alice, aliceGrantAccessId), false, 'the data grant is gone on alice\'s side');
  });
});
