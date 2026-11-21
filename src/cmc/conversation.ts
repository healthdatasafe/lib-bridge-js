/**
 * The standard conversation, the contact's side, for a bridge (data-model 4.22.0, `documentation/CONVERSATION.md`;
 * plan 128). hds-lib's `cmcConversation` holds the contract (checks, writes, reading); this binds it to one
 * relationship: her account through the data grant (`contribute` on her `received` child, `read` on her `sent`
 * child), the alerts on the bridge account's collectors stream of that person, which the CMC plugin delivers.
 *
 *   const conv = rel.conversation;
 *   await conv.postStatus(docId, 'reading', { attempt: 1 });
 *   await conv.proposeValues(docId, [{ candidateId, printed, proposal, status: 'clear', extraction }]);
 *   await conv.ask({ about: docId, code: 'is-this-yours', context: { identity } });
 *   await conv.postStatus(docId, 'awaiting-answers', { attempt: 1, counts });
 *   // later, on the person's answer alerts
 *   for (const alert of await conv.answerAlerts({ fromTime })) {
 *     const answer = await conv.answerOf(alert);      // R11: only on her sent child
 *     const state = await conv.read(alert.hds.about); // what she confirmed, corrected, skipped
 *   }
 *   await conv.postStatus(docId, 'done', { attempt: 1 });
 *   await conv.cleanupDocument(docId, 'done');         // R10
 *
 * The bridge never writes a value on her account: her app writes what she confirmed. Nothing here puts a value, a
 * name or a date in an alert (R6): the alerts carry kinds, ids, codes and counts, checked against the published
 * schema before they are posted.
 */
import { cmcConversation as cv } from 'hds-lib';
import type { ConversationAlert, ConversationItem, ConversationStreams, DocumentConversation, ProposedValuesWritten, TaskStatus } from 'hds-lib';
import { CmcRelationshipError } from './context.ts';
import type { CmcConnection, CmcConversation, CmcRelationshipRecord } from './types.ts';

export interface ConversationBinding {
  /** Her account, over the data grant. */
  person: () => CmcConnection;
  /** The bridge account (its collectors stream for this person carries the alerts). */
  bridge: () => CmcConnection;
  record: Readonly<Pick<CmcRelationshipRecord, 'grantedPermissions' | 'collectorStreamId'>>;
}

/** The contact's side of the conversation with one person. */
export function bindConversation (b: ConversationBinding): CmcConversation {
  const person = (): any => b.person();
  const bridge = (): any => b.bridge();
  let known: ConversationStreams | null = null;

  const streams = async (): Promise<ConversationStreams | null> => {
    if (known != null) return known;
    let found = cv.conversationStreamsOf(b.record.grantedPermissions as any);
    if (found.received == null || found.sent == null) {
      // granted after the record was written: read the live grant
      const [res] = await b.person().api([{ method: 'getAccessInfo', params: {} }]);
      if (res?.error == null) found = cv.conversationStreamsOf(res?.permissions ?? []);
    }
    if (found.received == null || found.sent == null) return null;
    known = { received: found.received, sent: found.sent };
    return known;
  };
  const required = async (): Promise<ConversationStreams> => {
    const s = await streams();
    if (s == null) throw new CmcRelationshipError('no-conversation', 'the person has not granted the conversation children (conversation-items) to this relationship');
    return s;
  };
  const alert = (hds: Record<string, unknown>): Promise<{ alertEventId: string }> =>
    cv.postConversationAlert(bridge(), b.record.collectorStreamId, hds);

  const read = async (about: string): Promise<DocumentConversation> =>
    cv.conversationOf(await cv.listConversationItems(person(), await required(), { about }), about);

  return {
    streams,

    async postStatus (about, status, opts) {
      const hds: Record<string, unknown> = { kind: 'task-status', about, status, attempt: opts.attempt };
      if (opts.counts != null) hds.counts = opts.counts;
      if (opts.errorCode != null) hds.errorCode = opts.errorCode;
      return await alert(hds);
    },

    async postNotice (code, about) {
      return await alert(about == null ? { kind: 'notice', code } : { kind: 'notice', code, about });
    },

    async proposeValues (about, values) {
      const contents = values.map(v => ({ kind: 'proposed-value', about, ...v }));
      const res: ProposedValuesWritten = await cv.writeProposedValues(person(), await required(), about, contents);
      const count = res.created.length + res.updated.length;
      const posted = count > 0 ? await alert({ kind: 'proposed-values', about, count }) : null;
      return { ...res, alertEventId: posted?.alertEventId ?? null };
    },

    async ask (question) {
      const content = { kind: 'question', ...question };
      const eventId = await cv.writeQuestion(person(), await required(), content);
      const { alertEventId } = await alert({ kind: 'question', eventId, about: content.about });
      return { eventId, alertEventId };
    },

    read,

    async answerAlerts (opts = {}) {
      const alerts: ConversationAlert[] = await cv.listConversationAlerts(bridge(), b.record.collectorStreamId, opts);
      return alerts.filter(a => a.direction === 'received' && a.kind === 'answer');
    },

    async answerOf (a) {
      const s = await required();
      if (a?.kind !== 'answer' || typeof a.hds?.eventId !== 'string') return null;
      let event: any = null;
      try {
        event = await b.person().apiOne('events.getOne', { id: a.hds.eventId }, 'event');
      } catch (e) {
        if ((e as any)?.innerObject?.id === 'unknown-resource' || (e as any)?.id === 'unknown-resource') return null;
        throw e;
      }
      const item: ConversationItem | undefined = cv.parseConversationItems([event], s)[0];
      if (item == null || item.direction !== 'sent' || item.about !== a.hds.about || item.content.inReplyTo !== a.hds.inReplyTo) return null;
      return item;
    },

    async deleteItems (eventIds) {
      await cv.deleteConversationItems(person(), eventIds);
    },

    async cleanupDocument (about, why) {
      const conv = await read(about);
      const ids = why === 'done' ? cv.itemsToDeleteAtDone(conv) : cv.itemsOfDocument(conv);
      await cv.deleteConversationItems(person(), ids);
      return ids;
    },

    async deleteOwnAlerts (alertEventIds) {
      await cv.deleteConversationItems(bridge(), alertEventIds);
    }
  };
}

export type { TaskStatus };
