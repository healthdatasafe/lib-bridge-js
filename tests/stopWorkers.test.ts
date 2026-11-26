import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { stopWorkers } from '../src/lib/stopWorkers.ts';

/** A cluster worker stand-in: `exitOn` the signals it exits on at once; `after` ms for a graceful one; none: never */
function fakeWorker ({ exitOn = [] as string[], after = 0, dead = false } = {}) {
  const w = new EventEmitter() as EventEmitter & { dead: boolean; signals: string[]; isDead: () => boolean; process: { kill: (s?: any) => boolean } };
  w.dead = dead;
  w.signals = [];
  w.isDead = () => w.dead;
  const exit = () => { if (!w.dead) { w.dead = true; w.emit('exit'); } };
  w.process = {
    kill: (s?: any) => {
      w.signals.push(String(s));
      if (s === 'SIGKILL') setImmediate(exit);
      else if (exitOn.includes(String(s))) setTimeout(exit, after);
      return true;
    }
  };
  return w;
}

/** B-2026-11-25-18: on SIGTERM the master waits for its workers (bounded) instead of exiting at once */
describe('[STW] stopWorkers', () => {
  it('[STW1] forwards the signal and resolves once every worker has exited, a graceful one included', async () => {
    const quick = fakeWorker({ exitOn: ['SIGTERM'] });
    const graceful = fakeWorker({ exitOn: ['SIGTERM'], after: 60 });
    const t0 = Date.now();
    const res = await stopWorkers([quick, graceful], 'SIGTERM', 2000);
    assert.deepEqual(res, { killed: 0 });
    assert.ok(Date.now() - t0 >= 50, 'waited for the graceful worker');
    assert.deepEqual(quick.signals, ['SIGTERM']);
    assert.deepEqual(graceful.signals, ['SIGTERM']);
  });

  it('[STW2] kills a worker still running at the timeout, and resolves', async () => {
    const stuck = fakeWorker();
    const ok = fakeWorker({ exitOn: ['SIGTERM'] });
    const res = await stopWorkers([stuck, ok], 'SIGTERM', 40);
    assert.deepEqual(res, { killed: 1 });
    assert.deepEqual(stuck.signals, ['SIGTERM', 'SIGKILL']);
    assert.deepEqual(ok.signals, ['SIGTERM']);
  });

  it('[STW3] no live worker: resolves at once, signals nobody', async () => {
    const gone = fakeWorker({ dead: true });
    assert.deepEqual(await stopWorkers([gone], 'SIGINT', 5000), { killed: 0 });
    assert.deepEqual(await stopWorkers([], 'SIGTERM', 5000), { killed: 0 });
    assert.deepEqual(gone.signals, []);
  });
});
