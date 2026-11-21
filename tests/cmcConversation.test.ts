import assert from 'node:assert/strict';
import { cmcConversation as cv, getHDSModel } from 'hds-lib';
import { bindConversation } from '../src/cmc/conversation.ts';
import { CmcRelationshipError } from '../src/cmc/context.ts';
import { FakeBridge } from './helpers/cmcFake.ts';

/**
 * The bridge's side of the standard conversation (data-model 4.22.0 CONVERSATION.md, plan 128 P1) against the
 * person's app as hds-lib implements it: a round trip on in-memory accounts, the CMC plugin's delivery simulated.
 */

const SCOPE = ':_cmc:apps:hds-bridge-reader';
const BRIDGE_COLLECTORS = `${SCOPE}:collectors:anna--datasafe-test`;
const HER_COLLECTORS = ':_cmc:apps:hds-patient:collectors:reader--datasafe-test';
const DOC = 'ckdoc0000001';
const extraction = { engine: 'hds-reader', engineVersion: '0.3.0', kbVersion: '0.4.0', backend: 'text-layer' };

function apiError (id: string): Error {
  return Object.assign(new Error(id), { id, innerObject: { id } });
}

/** Her account as the platform keeps it (streams, events with created / modified, scope updates applied). */
class FakePerson {
  streams: any[] = [];
  events = new Map<string, any>();
  grant: any[] = [];
  clock = 1000;
  n = 0;
  async accessInfo (): Promise<any> { return { type: 'personal' }; }
  async api (calls: any[]): Promise<any[]> {
    const out = [];
    for (const c of calls) {
      try { out.push(await this.apiOne(c.method, c.params)); } catch (e: any) { out.push({ error: { id: e.id } }); }
    }
    return out;
  }

  async apiOne (method: string, p: any, key?: string): Promise<any> {
    const ret = (k: string, v: any): any => key != null ? v : { [k]: v };
    const tick = (): number => ++this.clock;
    switch (method) {
      case 'getAccessInfo': return { permissions: structuredClone(this.grant) };
      case 'streams.get':
        if (p.parentId != null && !this.streams.some(s => s.id === p.parentId)) throw apiError('unknown-referenced-resource');
        return ret('streams', this.streams.filter(s => s.parentId === (p.parentId ?? null) && (p.state === 'all' || s.trashed !== true)));
      case 'streams.create':
        if (this.streams.some(s => s.id === p.id)) throw apiError('item-already-exists');
        this.streams.push({ parentId: null, ...p });
        return ret('stream', p);
      case 'events.create': {
        const now = tick();
        const e = { id: 'p' + (++this.n), time: now, ...structuredClone(p), created: now, modified: now };
        this.events.set(e.id, e);
        return ret('event', structuredClone(e));
      }
      case 'events.getOne': {
        const e = this.events.get(p.id);
        if (e == null || e.trashed === true) throw apiError('unknown-resource');
        if (e.type === 'consent/scope-update-cmc' && e.content.applied == null) {
          e.content = { ...e.content, applied: true, status: 'completed' };
          this.grant = e.content.newPermissions;
        }
        return ret('event', structuredClone(e));
      }
      case 'events.update': {
        const e = this.events.get(p.id);
        if (e == null) throw apiError('unknown-resource');
        Object.assign(e, structuredClone(p.update), { modified: tick() });
        return ret('event', structuredClone(e));
      }
      case 'events.delete': {
        const e = this.events.get(p.id);
        if (e == null) throw apiError('unknown-resource');
        if (e.trashed !== true) { e.trashed = true; return ret('event', e); }
        this.events.delete(p.id);
        return ret('eventDeletion', { id: p.id });
      }
      case 'events.get':
        return ret('events', [...this.events.values()]
          .filter(e => (p.state === 'all' || e.trashed !== true) && e.streamIds.some((s: string) => p.streams.includes(s)))
          .filter(e => p.types == null || p.types.includes(e.type))
          .filter(e => (p.fromTime == null || e.time >= p.fromTime) && (p.toTime == null || e.time <= p.toTime))
          .map(e => structuredClone(e)));
      default:
        throw apiError('unknown-method');
    }
  }
}

function pv (candidateId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    candidateId,
    printed: { label: 'Ferritine', value: '48', unit: 'ng/mL' },
    proposal: { itemKey: 'body-blood-serum-ferritin', type: 'concentration/ug-l', content: 48, time: 1773316800, clientData: { hdsTimePrecision: 'day' } },
    status: 'clear',
    extraction,
    ...over
  };
}

describe('[BCNV] conversation, the bridge\'s side', function () {
  let her: FakePerson;
  let bridge: FakeBridge;
  let rel: { accessId: string; localCollectorStreamId: string; grantedPermissions: any[] };

  /** The CMC plugin: her alerts copied to the bridge's collectors stream, stamped `from`. */
  function deliver (): void {
    for (const e of her.events.values()) {
      if (e.type !== 'notification/alert-cmc' || bridge.events.some(b => b.content?.deliveredFrom === e.id)) continue;
      bridge.add({ time: e.time, streamIds: [BRIDGE_COLLECTORS], type: e.type, content: { ...structuredClone(e.content), from: { username: 'anna', host: 'datasafe.test' }, deliveredFrom: e.id } });
    }
  }
  const conversation = (grantedPermissions: any[]): ReturnType<typeof bindConversation> =>
    bindConversation({ person: () => her as any, bridge: () => bridge as any, record: { grantedPermissions, collectorStreamId: BRIDGE_COLLECTORS } });

  before(async function () {
    this.timeout(20000);
    await getHDSModel().load('https://model.datasafe.dev/pack.json');
  });

  beforeEach(async () => {
    her = new FakePerson();
    bridge = new FakeBridge();
    rel = { accessId: 'acc-1:2', localCollectorStreamId: HER_COLLECTORS, grantedPermissions: [{ streamId: 'hds-noop', level: 'read' }] };
    await cv.ensureConversationStreams(her as any, rel); // her app, at accept
    rel.grantedPermissions = her.grant;
  });

  it('[BCNV1] round trip: the bridge proposes and asks, her app answers and writes the value, the bridge reads the answer and cleans up', async () => {
    const conv = conversation(her.grant);
    const streams = await conv.streams();
    assert.ok(streams != null && cv.isConversationStreamId(streams.received) && cv.isConversationStreamId(streams.sent));

    await conv.postStatus(DOC, 'reading', { attempt: 1 });
    const proposed = await conv.proposeValues(DOC, [pv('c1'), pv('c2')]);
    assert.deepEqual(proposed.created.map(c => c.candidateId), ['c1', 'c2']);
    assert.ok(proposed.alertEventId);
    const asked = await conv.ask({ about: DOC, code: 'which-date', context: { dates: [{ day: '2026-03-12', text: '12.03.2026', role: 'sampling' }] } });
    await conv.postStatus(DOC, 'awaiting-answers', { attempt: 1, counts: { proposed: 2, questions: 1, keptAside: 0, dropped: 3 } });
    const sent = bridge.ofType('notification/alert-cmc');
    assert.deepEqual(sent.map(e => e.content.hds.kind), ['task-status', 'proposed-values', 'question', 'task-status']);
    assert.ok(sent.every(e => e.streamIds[0] === BRIDGE_COLLECTORS && e.content.title.en != null && !JSON.stringify(e.content).includes('Ferritine')), 'R6, R12');
    assert.deepEqual(her.events.get(asked.eventId).streamIds, [streams.received]);

    // her app: reads, answers the date question, confirms c1, skips c2
    const shownAt = her.clock;
    const engines = cv.vouchedEnginesFor('hds-bridge-reader');
    const view = cv.conversationOf(await cv.listConversationItems(her as any, streams, { about: DOC }), DOC);
    assert.deepEqual(view.proposedValues.map(p => cv.proposalRefusal(p, engines)), [null, null]);
    await cv.answerQuestion(her as any, rel, { questionId: asked.eventId, action: 'confirm', time: 1773316800, timePrecision: 'day', shownAt });
    const accepted = await cv.acceptProposedValues(her as any, rel, { about: DOC, decisions: [{ candidateId: 'c1', action: 'confirm' }], shownAt: her.clock, engines });
    await cv.answerProposedValues(her as any, rel, { about: DOC, candidateIds: ['c2'], action: 'skip' });
    const valueId = accepted.answers[0]!.written[0]!.eventId;
    assert.deepEqual(her.events.get(valueId).streamIds, ['body-blood-serum-ferritin'], 'her app wrote the value on its item');
    deliver();

    // the bridge reads her answers
    const answers = await conv.answerAlerts();
    assert.equal(answers.length, 3);
    const items = await Promise.all(answers.map(a => conv.answerOf(a)));
    assert.deepEqual(items.map(i => i?.content.action), ['confirm', 'confirm', 'skip']);
    const state = await conv.read(DOC);
    assert.deepEqual(state.proposedValues.map(p => [p.candidateId, p.state, p.writtenEventId]), [['c1', 'confirmed', valueId], ['c2', 'skipped', null]]);

    // R5: a re-read does not propose a written candidate again, and rewrites nothing answered
    const again = await conv.proposeValues(DOC, [pv('c1'), pv('c2')]);
    assert.deepEqual([again.created, again.updated, again.alertEventId], [[], [], null]);
    assert.deepEqual(again.skipped.map(s => s.reason), ['written', 'answered']);

    // R10 at done: the settled items go from her account, her answers and her value stay
    await conv.postStatus(DOC, 'done', { attempt: 1 });
    const deleted = await conv.cleanupDocument(DOC, 'done');
    assert.equal(deleted.length, 3);
    assert.ok(deleted.every(id => !her.events.has(id)));
    assert.ok(her.events.has(valueId));
    assert.equal(cv.conversationOf(await cv.listConversationItems(her as any, streams, { about: DOC }), DOC).answers.length, 3);
    await conv.deleteOwnAlerts(bridge.ofType('notification/alert-cmc').filter(e => e.content.from == null).map(e => e.id));
    assert.equal(bridge.ofType('notification/alert-cmc').filter(e => e.content.from == null).length, 0);
  });

  it('[BCNV2] checks before writing: an invalid item or alert is refused, nothing is written', async () => {
    const conv = conversation(her.grant);
    const before = her.events.size;
    await assert.rejects(conv.proposeValues(DOC, [pv('c1', { confidence: 0.9 })]), /confidence: not allowed/);
    await assert.rejects(conv.proposeValues(DOC, [pv('c1', { status: 'kept-aside' })]), /reason is required/);
    await assert.rejects(conv.ask({ about: DOC, code: 'which-unit', candidateId: 'nope', options: ['ug/L'] }), /not a proposed value/);
    await assert.rejects(conv.postStatus(DOC, 'error', { attempt: 1 }), /errorCode is required/);
    await assert.rejects(conv.postNotice('Free text, never'), /invalid hds block/);
    assert.equal(her.events.size, before);
    assert.equal(bridge.ofType('notification/alert-cmc').length, 0);
    await conv.postNotice('no-result-found', DOC);
    assert.deepEqual(bridge.ofType('notification/alert-cmc')[0]!.content.hds, { kind: 'notice', code: 'no-result-found', about: DOC });
  });

  it('[BCNV3] the children come from the record, else the live grant; none granted is a no-conversation refusal', async () => {
    assert.notEqual(await conversation([]).streams(), null, 'read from the live grant');
    her.grant = [{ streamId: 'hds-noop', level: 'read' }];
    const none = conversation([]);
    assert.equal(await none.streams(), null);
    await assert.rejects(none.proposeValues(DOC, [pv('c1')]), (e: any) => e instanceof CmcRelationshipError && e.id === 'no-conversation');
  });

  it('[BCNV4] R11: an answer alert pointing outside her sent child, or not matching the answer, resolves to nothing', async () => {
    const conv = conversation(her.grant);
    const streams = (await conv.streams())!;
    await conv.proposeValues(DOC, [pv('c1')]);
    const elsewhere = await her.apiOne('events.create', { streamIds: [streams.received], type: 'message/hds-conversation-v1', content: { kind: 'answer', about: DOC, inReplyTo: 'x', action: 'skip' } }, 'event');
    const alert = (eventId: string, inReplyTo = 'x'): any => ({ kind: 'answer', direction: 'received', hds: { kind: 'answer', eventId, inReplyTo, about: DOC } });
    assert.equal(await conv.answerOf(alert(elsewhere.id)), null);
    assert.equal(await conv.answerOf(alert('missing')), null);
    const pvId = (await conv.read(DOC)).proposedValues[0]!.item.id;
    const real = await cv.answerProposedValues(her as any, rel, { about: DOC, candidateIds: ['c1'], action: 'skip' });
    assert.equal(await conv.answerOf(alert(real.answerEventId, 'other')), null);
    assert.equal((await conv.answerOf(alert(real.answerEventId, pvId)))?.content.action, 'skip');
  });

  it('[BCNV5] not-mine or unshared: every item of the document is deleted, kept-aside ones included', async () => {
    const conv = conversation(her.grant);
    await conv.proposeValues(DOC, [pv('c1'), { ...pv('k1', { status: 'kept-aside', reason: 'no-item' }), proposal: undefined }].map(v => JSON.parse(JSON.stringify(v))));
    await conv.ask({ about: DOC, code: 'is-this-yours', context: { identity: { name: 'DUPONT Marie', birthDay: '1985-03-14' } } });
    const ids = await conv.cleanupDocument(DOC, 'unshared');
    assert.equal(ids.length, 3);
    assert.equal((await conv.read(DOC)).proposedValues.length + (await conv.read(DOC)).questions.length, 0);
  });
});
