import assert from 'node:assert/strict';
import cluster, { type Worker } from 'node:cluster';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cacheSet, cacheGet, cacheDel, cacheTake, initCacheMaster } from '../src/lib/cache.ts';

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
});
