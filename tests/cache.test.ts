import assert from 'node:assert/strict';
import cluster, { type Worker } from 'node:cluster';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cacheSet, cacheGet, cacheDel, cacheTake, cacheLock, cacheRenew, cacheUnlock, initCacheMaster, onTakeMessageInPrimary
} from '../src/lib/cache.ts';

/**
 * Shared cache: TTL in local (non-cluster) mode (B-2026-10-14-7) and the single-use
 * `cacheTake` across cluster workers (B-2026-10-14-8). Mocha runs as a cluster primary, so the
 * plain calls below use the local map.
 */

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('[CCHL] cache in local mode', function () {
  it('[CCHA] an entry set with ttlMs expires', async () => {
    await cacheSet('cchl-a', 'v', 20);
    assert.equal(await cacheGet('cchl-a'), 'v');
    await sleep(40);
    assert.equal(await cacheGet('cchl-a'), undefined);
  });

  it('[CCHB] an entry set without ttlMs, or with 0, does not expire', async () => {
    await cacheSet('cchl-b1', 'v');
    await cacheSet('cchl-b2', 'v', 0);
    await sleep(30);
    assert.equal(await cacheGet('cchl-b1'), 'v');
    assert.equal(await cacheGet('cchl-b2'), 'v');
    await cacheDel('cchl-b1');
    await cacheDel('cchl-b2');
  });

  it('[CCHC] cacheTake returns the value once, then undefined', async () => {
    await cacheSet('cchl-c', { n: 1 }, 1000);
    assert.deepEqual(await cacheTake('cchl-c'), { n: 1 });
    assert.equal(await cacheTake('cchl-c'), undefined);
    assert.equal(await cacheGet('cchl-c'), undefined);
  });

  it('[CCHD] cacheTake does not return an expired entry', async () => {
    await cacheSet('cchl-d', 'v', 10);
    await sleep(30);
    assert.equal(await cacheTake('cchl-d'), undefined);
  });
});

describe('[CCHK] leases in local mode', function () {
  it('[CCHF] a held lease refuses a second lock; unlock frees it', async () => {
    const token = await cacheLock('cchk-f', 1000);
    assert.equal(typeof token, 'string');
    assert.equal(await cacheLock('cchk-f', 1000), null);
    assert.equal(await cacheUnlock('cchk-f', token!), true);
    const next = await cacheLock('cchk-f', 1000);
    assert.ok(next != null && next !== token);
    await cacheUnlock('cchk-f', next);
  });

  it('[CCHG] unlock and renew with a wrong token do nothing', async () => {
    const token = await cacheLock('cchk-g', 1000);
    assert.equal(await cacheUnlock('cchk-g', 'not-the-token'), false);
    assert.equal(await cacheRenew('cchk-g', 'not-the-token', 1000), false);
    assert.equal(await cacheLock('cchk-g', 1000), null, 'still held');
    await cacheUnlock('cchk-g', token!);
  });

  it('[CCHH] an expired lease is free; the expired holder can neither renew nor release its successor', async () => {
    const old = await cacheLock('cchk-h', 20);
    await sleep(40);
    const successor = await cacheLock('cchk-h', 1000);
    assert.ok(successor != null);
    assert.equal(await cacheRenew('cchk-h', old!, 1000), false);
    assert.equal(await cacheUnlock('cchk-h', old!), false);
    assert.equal(await cacheLock('cchk-h', 1000), null, 'successor still holds it');
    await cacheUnlock('cchk-h', successor);
  });

  it('[CCHI] renew extends the lease past its first TTL', async () => {
    const token = await cacheLock('cchk-i', 40);
    await sleep(25);
    assert.equal(await cacheRenew('cchk-i', token!, 100), true);
    await sleep(30);
    assert.equal(await cacheLock('cchk-i', 1000), null, 'renewed lease still held');
    await cacheUnlock('cchk-i', token!);
  });

  it('[CCHJ] a lease and a cacheTake on the same key do not block each other', async () => {
    const token = await cacheLock('cchk-j', 1000);
    await cacheSet('cchk-j', 'v', 1000);
    assert.equal(await cacheTake('cchk-j'), 'v');
    await cacheUnlock('cchk-j', token!);
  });

  it('[CCHL] a non-positive ttlMs is refused', async () => {
    await assert.rejects(() => cacheLock('cchk-l', 0));
    await assert.rejects(() => cacheRenew('cchk-l', 'x', -1));
  });
});

describe('[CCHP] primary lock handler', function () {
  function fakeWorker () {
    const sent: any[] = [];
    return { sent, send: (m: unknown) => { sent.push(m); return true; } };
  }
  const CH = 'lib-bridge-js:cache-take';
  const ask = (w: ReturnType<typeof fakeWorker>, msg: Record<string, unknown>) => {
    onTakeMessageInPrimary(w, { channel: CH, id: 'r' + Math.random(), ...msg });
    return w.sent.at(-1);
  };

  it('[CCHM] lock grants a token once, per-call TTL; renew/unlock need that token', async () => {
    const w = fakeWorker();
    const first = ask(w, { op: 'lock', key: 'lease:p-m', ttlMs: 1000 });
    assert.equal(first.op, 'reply');
    assert.equal(first.granted, true);
    assert.equal(typeof first.token, 'string');
    assert.equal(ask(w, { op: 'lock', key: 'lease:p-m', ttlMs: 1000 }).granted, false);
    assert.equal(ask(w, { op: 'renew', key: 'lease:p-m', token: 'bad', ttlMs: 1000 }).granted, false);
    assert.equal(ask(w, { op: 'unlock', key: 'lease:p-m', token: 'bad' }).granted, false);
    assert.equal(ask(w, { op: 'renew', key: 'lease:p-m', token: first.token, ttlMs: 1000 }).granted, true);
    assert.equal(ask(w, { op: 'unlock', key: 'lease:p-m', token: first.token }).granted, true);
    assert.equal(ask(w, { op: 'lock', key: 'lease:p-m', ttlMs: 1000 }).granted, true);
  });

  it('[CCHN] an expired lock is re-granted and its old token is dead', async () => {
    const w = fakeWorker();
    const old = ask(w, { op: 'lock', key: 'lease:p-n', ttlMs: 20 });
    await sleep(40);
    const next = ask(w, { op: 'lock', key: 'lease:p-n', ttlMs: 1000 });
    assert.equal(next.granted, true);
    assert.equal(ask(w, { op: 'unlock', key: 'lease:p-n', token: old.token }).granted, false);
    assert.equal(ask(w, { op: 'lock', key: 'lease:p-n', ttlMs: 1000 }).granted, false);
    ask(w, { op: 'unlock', key: 'lease:p-n', token: next.token });
  });

  it('[CCHO] a fire-and-forget unlock (no id) gets no reply; foreign messages are ignored', () => {
    const w = fakeWorker();
    const lock = ask(w, { op: 'lock', key: 'take:p-o' });
    onTakeMessageInPrimary(w, { channel: CH, op: 'unlock', key: 'take:p-o', token: lock.token });
    onTakeMessageInPrimary(w, { cmd: 'something-else' });
    assert.equal(w.sent.length, 1);
    assert.equal(ask(w, { op: 'lock', key: 'take:p-o' }).granted, true, 'released');
  });
});

describe('[CCHW] cacheTake across cluster workers', function () {
  this.timeout(30000);
  const WORKERS = 4;
  const ROUNDS = 20;
  let workers: Worker[] = [];

  function next (worker: Worker, cmd: string): Promise<any> {
    return new Promise(resolve => {
      const onMessage = (msg: any) => {
        if (msg?.cmd !== cmd) return;
        worker.off('message', onMessage);
        resolve(msg);
      };
      worker.on('message', onMessage);
    });
  }

  before(async () => {
    initCacheMaster();
    const here = path.dirname(fileURLToPath(import.meta.url));
    cluster.setupPrimary({ exec: path.join(here, 'helpers/cacheTakeWorker.ts'), silent: true });
    workers = Array.from({ length: WORKERS }, () => cluster.fork());
    await Promise.all(workers.map(w => next(w, 'ready')));
  });

  after(() => {
    for (const w of workers) w.kill();
  });

  it('[CCHE] of workers taking the same key at once, exactly one gets the value, round after round', async () => {
    const setter = workers[0]!;
    for (let round = 0; round < ROUNDS; round++) {
      const setDone = next(setter, 'set-done');
      setter.send({ cmd: 'set', key: 'cchw-state', value: `v${round}`, ttlMs: 60000 });
      await setDone;
      const replies = workers.map(w => next(w, 'taken'));
      for (const w of workers) w.send({ cmd: 'take', key: 'cchw-state' });
      const values = (await Promise.all(replies)).map(r => r.value).filter(v => v !== null);
      assert.deepEqual(values, [`v${round}`], `round ${round}`);
    }
  });

  it('[CCHQ] of workers locking the same key at once, exactly one gets a token; only it can release', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const replies = workers.map(w => next(w, 'locked'));
      for (const w of workers) w.send({ cmd: 'lock', key: 'cchw-lease', ttlMs: 60000 });
      const results = await Promise.all(replies);
      const holders = results.map((r, i) => ({ i, token: r.token })).filter(r => r.token != null);
      assert.equal(holders.length, 1, `round ${round}`);
      const holder = holders[0]!;
      const other = workers[(holder.i + 1) % WORKERS]!;
      const refused = next(other, 'unlocked');
      other.send({ cmd: 'unlock', key: 'cchw-lease', token: 'not-the-token' });
      assert.equal((await refused).ok, false);
      const renewed = next(workers[holder.i]!, 'renewed');
      workers[holder.i]!.send({ cmd: 'renew', key: 'cchw-lease', token: holder.token, ttlMs: 60000 });
      assert.equal((await renewed).ok, true);
      const released = next(workers[holder.i]!, 'unlocked');
      workers[holder.i]!.send({ cmd: 'unlock', key: 'cchw-lease', token: holder.token });
      assert.equal((await released).ok, true);
    }
  });
});
