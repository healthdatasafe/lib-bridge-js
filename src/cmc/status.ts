/**
 * Connector status on the person's account and system alerts (DESIGN.md §5.6, §5.7), lifted
 * from bridge-mira's `model/connectorStatus.ts` and `maybeNotifyReauth`.
 *
 * Status writes are best-effort: never throw, queued per userKey so outcomes land in order, and
 * bounded (5 s) so a hung user core cannot stall the caller or the queue behind it. A grant
 * that cannot write the leaf (old grant without it, revoked, expired) is warned about once per
 * userKey per process: nothing to retry until the person reconnects.
 */
import { cmc } from 'hds-lib';
import { recordConnectorOutcome, isConnectorStatusAccessError, type ConnectorOutcome } from '../lib/connectorStatus.ts';
import { errorMessage, type Ctx, type Entry } from './context.ts';
import type { SystemAlert } from './types.ts';
import { logKey } from './logKey.ts';

export const STATUS_WRITE_TIMEOUT_MS = 5_000;

const queues = new Map<string, Promise<void>>();
const warnedNoLeaf = new Set<string>();

async function write (ctx: Ctx, entry: Entry, leaf: string, outcome: ConnectorOutcome): Promise<void> {
  try {
    const res = await recordConnectorOutcome(ctx.connectionFor(entry.apiEndpoint), leaf, outcome, Math.floor(ctx.now() / 1000));
    warnedNoLeaf.delete(entry.userKey);
    ctx.logger.debug(`cmc status ${logKey(entry.userKey)}: ${res.action} (${res.content.status})`);
  } catch (e) {
    if (isConnectorStatusAccessError(e)) {
      if (!warnedNoLeaf.has(entry.userKey)) {
        warnedNoLeaf.add(entry.userKey);
        ctx.logger.warn(`cmc status ${logKey(entry.userKey)}: grant cannot write ${leaf} (${(e as { id?: string }).id}); not published until it can`);
      }
      return;
    }
    ctx.logger.warn(`cmc status ${logKey(entry.userKey)}: publishing failed: ${errorMessage(e)}`);
  }
}

async function bounded (ctx: Ctx, entry: Entry, leaf: string, outcome: ConnectorOutcome, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
    timer.unref();
  });
  try {
    const r = await Promise.race([write(ctx, entry, leaf, outcome).then(() => 'done' as const), timeout]);
    if (r === 'timeout') ctx.logger.warn(`cmc status ${logKey(entry.userKey)}: write timed out after ${timeoutMs} ms (${outcome.kind}), abandoned`);
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}

/** Queue a status write; resolves when THIS write is done or timed out. Never rejects. */
export function publishStatus (ctx: Ctx, entry: Entry, outcome: ConnectorOutcome, timeoutMs = STATUS_WRITE_TIMEOUT_MS): Promise<void> {
  const leaf = ctx.hooks.statusStreamId;
  if (leaf == null || leaf === '') return Promise.resolve();
  const previous = queues.get(entry.userKey) ?? Promise.resolve();
  const next = previous.then(() => bounded(ctx, entry, leaf, outcome, timeoutMs));
  queues.set(entry.userKey, next);
  next.finally(() => { if (queues.get(entry.userKey) === next) queues.delete(entry.userKey); }).catch(() => {});
  return next;
}

/** Wait for every queued status write (stop, tests). */
export async function settleStatusWrites (): Promise<void> {
  while (queues.size > 0) await Promise.allSettled([...queues.values()]);
}

/** A value-free alert on the relationship's collectors stream. */
export async function sendAlert (ctx: Ctx, to: { username: string, host: string, scopeStreamId: string }, a: SystemAlert): Promise<void> {
  await cmc.sendSystemAlert(ctx.bridge(), {
    scopeStreamId: to.scopeStreamId,
    peerSlug: cmc.counterpartySlug({ username: to.username, host: to.host }),
    level: a.level ?? 'info',
    title: a.title,
    body: a.body
  });
}
