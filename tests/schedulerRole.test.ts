import assert from 'node:assert/strict';
import { createSchedulerRole, isSchedulerWorker, SCHEDULER_ENV } from '../src/lib/schedulerRole.ts';

/**
 * The scheduler role: exactly one live worker runs periodic jobs, and its replacement inherits
 * the role. Before this, bridges elected `cluster.worker.id === 1`, which no respawned worker
 * ever is again, so the daily sync stopped for good when worker 1 died.
 */

/** Fake cluster: incremental ids like Node's, records the env each fork got. */
function fakeCluster () {
  let nextId = 0;
  const envs = new Map<number, Record<string, string>>();
  const live = new Set<number>();
  return {
    fork: (env: Record<string, string>) => { const id = ++nextId; envs.set(id, env); live.add(id); return id; },
    kill: (id: number) => { live.delete(id); },
    schedulers: () => [...live].filter(id => envs.get(id)?.[SCHEDULER_ENV] === '1'),
    envs
  };
}

describe('[SCHX] scheduler role', () => {
  it('[SCH1] of N initial forks exactly one is the scheduler; the others get an explicit 0', () => {
    const c = fakeCluster();
    const role = createSchedulerRole();
    for (let i = 0; i < 4; i++) role.fork(c.fork);
    assert.deepEqual(c.schedulers(), [1]);
    assert.equal(role.holder(), 1);
    assert.equal(c.envs.get(2)?.[SCHEDULER_ENV], '0', 'explicit, so the app env cannot override it');
  });

  it('[SCH2] the scheduler dies: its replacement (a new id) inherits the role', () => {
    const c = fakeCluster();
    const role = createSchedulerRole();
    for (let i = 0; i < 3; i++) role.fork(c.fork);
    c.kill(1); role.workerExited(1);
    assert.equal(role.holder(), null);
    const replacement = role.fork(c.fork);
    assert.equal(replacement, 4);
    assert.deepEqual(c.schedulers(), [4]);
    // and again: the role keeps moving with each respawn
    c.kill(4); role.workerExited(4);
    role.fork(c.fork);
    assert.deepEqual(c.schedulers(), [5]);
  });

  it('[SCH3] another worker dies: the role stays where it is, the replacement is not a scheduler', () => {
    const c = fakeCluster();
    const role = createSchedulerRole();
    for (let i = 0; i < 3; i++) role.fork(c.fork);
    c.kill(2); role.workerExited(2);
    role.fork(c.fork);
    assert.deepEqual(c.schedulers(), [1]);
  });

  it('[SCH4] isSchedulerWorker: workers read the env, a non-worker process always schedules', () => {
    assert.equal(isSchedulerWorker(true, { [SCHEDULER_ENV]: '1' }), true);
    assert.equal(isSchedulerWorker(true, { [SCHEDULER_ENV]: '0' }), false);
    assert.equal(isSchedulerWorker(true, {}), false);
    assert.equal(isSchedulerWorker(false, {}), true);
    assert.equal(isSchedulerWorker(false, { [SCHEDULER_ENV]: '0' }), true);
  });
});
