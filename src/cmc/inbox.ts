/**
 * The inbox loop (DESIGN.md §5.2 steps 1-4), scheduler worker only, so the cursor event has a
 * single writer.
 *
 * Read by a persisted cursor lagging `now` by `lagS` (an event whose time was set before a slow
 * commit is still read), ascending, page by page. `fromTime` is inclusive: the ids at the
 * cursor's time (`overlapIds`) are not processed twice. An arrival that cannot be decided now
 * (grant state unknown, core unreachable, relationship busy) goes to a persisted retry list
 * with backoff, and the cursor still advances: one unreachable core never stalls the others.
 * This replaces mira's in-memory 24 h lookback (B-2026-11-18-11).
 */
import { SyncStateStore } from '../lib/syncState.ts';
import { getCmcStreamId } from '../lib/bridgeAccount.ts';
import { nowS, recordError, record, errorMessage, type Ctx } from './context.ts';
import { processAccept, type ArrivalOutcome } from './accept.ts';
import { processRevokeNotice } from './revoke.ts';

export const INBOX_STATE_KEY = 'inbox';
export const PAGE_LIMIT = 200;
const RETRY_BASE_S = 30;
const RETRY_MAX_DELAY_S = 3600;
/** About two days at the capped delay: an arrival still undecided then is dropped (logged). */
const RETRY_MAX_ATTEMPTS = 50;
/**
 * An empty window still moves the cursor to `toTime`, persisted at most this often (a tick runs
 * every 30 s). Without it a quiet inbox never writes a cursor, and a restart falls back to
 * `initialCursor` again: an accept made during a long outage before the first arrival was lost.
 */
export const EMPTY_ADVANCE_S = 3600;

export interface RetryItem { id: string; attempts: number; notBefore: number }
export interface InboxState { cursor: number; overlapIds: string[]; retry: RetryItem[] }

const ACCEPT = 'consent/accept-cmc';
const REVOKE = 'consent/revoke-cmc';

export function inboxStore (ctx: Ctx): SyncStateStore<InboxState> {
  return new SyncStateStore<InboxState>({
    connection: () => ctx.bridge(),
    mainStreamId: () => '',
    streamId: () => getCmcStreamId()
  });
}

async function processArrival (ctx: Ctx, event: any): Promise<ArrivalOutcome> {
  try {
    if (event.type === ACCEPT) return await processAccept(ctx, event);
    if (event.type === REVOKE) return await processRevokeNotice(ctx, event);
    return 'skip';
  } catch (e) {
    ctx.logger.warn(`cmc inbox: arrival ${event.id} failed, will retry: ${errorMessage(e)}`);
    return 'retry';
  }
}

function scheduleRetry (ctx: Ctx, state: InboxState, id: string, attempts: number): void {
  if (attempts >= RETRY_MAX_ATTEMPTS) {
    ctx.logger.warn(`cmc inbox: arrival ${id} dropped after ${attempts} attempts`);
    return;
  }
  const delay = Math.min(RETRY_BASE_S * 2 ** attempts, RETRY_MAX_DELAY_S);
  state.retry.push({ id, attempts: attempts + 1, notBefore: nowS(ctx) + delay });
  recordError('cmc_inbox_retry');
}

export async function inboxTick (ctx: Ctx): Promise<void> {
  const started = ctx.now();
  const store = inboxStore(ctx);
  const stored = await store.get(INBOX_STATE_KEY);
  const state: InboxState = { cursor: ctx.o.inbox.initialCursor ?? 0, overlapIds: [], retry: [], ...(stored ?? {}) };
  const persist = async (): Promise<void> => {
    if (await store.patch(INBOX_STATE_KEY, state) == null) throw new Error('cmc inbox: cursor write failed');
    ctx.seen.cursor = state.cursor;
  };
  const bridge = ctx.bridge();

  // 1. the retry list, before new events
  const due = state.retry.filter(r => r.notBefore <= nowS(ctx));
  if (due.length > 0) {
    state.retry = state.retry.filter(r => r.notBefore > nowS(ctx));
    for (const r of due) {
      const got = await bridge.api([{ method: 'events.getOne', params: { id: r.id } }]);
      if (got?.[0]?.error?.id === 'unknown-resource') continue;
      const event = got?.[0]?.event;
      const outcome = event == null ? 'retry' : await processArrival(ctx, event);
      if (outcome === 'retry') scheduleRetry(ctx, state, r.id, r.attempts);
    }
    await persist();
  }

  // 2. new arrivals, oldest first, page by page
  const toTime = nowS(ctx) - ctx.o.inbox.lagS;
  let fresh = 0;
  let drained = false;
  for (;;) {
    if (state.cursor > toTime) { drained = true; break; }
    const res = await bridge.api([{
      method: 'events.get',
      params: { streams: [':_cmc:inbox'], types: [ACCEPT, REVOKE], fromTime: state.cursor, toTime, sortAscending: true, limit: PAGE_LIMIT }
    }]);
    if (res?.[0]?.error != null) throw new Error(`cmc inbox: read failed: ${res[0].error.id}`);
    const events: any[] = res?.[0]?.events ?? [];
    if (events.length === 0) { drained = true; break; }
    const seen = new Set(state.overlapIds);
    const queued = new Set(state.retry.map(r => r.id));
    let pageFresh = 0;
    for (const event of events) {
      if (seen.has(event.id) || queued.has(event.id)) continue;
      pageFresh++;
      if (await processArrival(ctx, event) === 'retry') scheduleRetry(ctx, state, event.id, 0);
    }
    fresh += pageFresh;
    const last = events[events.length - 1].time as number;
    const atLast = events.filter(e => e.time === last).map(e => e.id as string);
    const overlapIds = last === state.cursor ? [...new Set([...state.overlapIds, ...atLast])] : atLast;
    const moved = last !== state.cursor;
    // the arrivals at the cursor come back on every tick: rewrite the state only when it changed
    const changed = moved || pageFresh > 0 || overlapIds.length !== state.overlapIds.length;
    state.overlapIds = overlapIds;
    state.cursor = last;
    if (changed) await persist();
    if (events.length < PAGE_LIMIT) { drained = true; break; }
    if (!moved) {
      // a full page at one single time: the cursor cannot page past it
      ctx.logger.warn(`cmc inbox: more than ${PAGE_LIMIT} arrivals at time ${last}; the rest waits for the next tick`);
      break;
    }
  }
  // 3. nothing new up to toTime: move past the empty window (throttled, see EMPTY_ADVANCE_S)
  const idle = fresh === 0 && drained;
  if (idle && toTime > state.cursor && (stored == null || toTime - state.cursor >= EMPTY_ADVANCE_S)) {
    state.cursor = toTime;
    state.overlapIds = [];
    await persist();
  }
  ctx.seen.cursor = idle ? Math.max(state.cursor, toTime) : state.cursor;
  record('cmc:inbox-poll', '2xx', started, ctx);
}
