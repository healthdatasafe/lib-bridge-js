/**
 * Exactly one live cluster worker holds the "scheduler" role (daily syncs and other periodic
 * jobs that must not run once per worker).
 *
 * Bridges used to elect it by `cluster.worker.id === 1`. Node assigns ids incrementally, so a
 * respawned worker never gets id 1 again: once worker 1 died, no worker ran the scheduler until
 * the whole app restarted. Now the master decides: it marks one fork with
 * `HDS_BRIDGE_SCHEDULER=1` (every other fork gets `0`, explicitly, so a value set in the app's
 * own environment cannot make every worker a scheduler), and when that worker exits, the next
 * fork (its replacement) inherits the role.
 *
 * The controller is pure (it never calls `cluster`) so the handover is unit-testable;
 * `start.ts` wires it to `cluster.fork` / `cluster.on('exit')`.
 */

import cluster from 'node:cluster';

export const SCHEDULER_ENV = 'HDS_BRIDGE_SCHEDULER';

export interface SchedulerRole {
  /**
   * Fork one worker through `fork(env)` (which returns the new worker's id), giving it the
   * role when no live worker holds it. Returns the id.
   */
  fork: (fork: (env: Record<string, string>) => number) => number;
  /** A worker exited: if it held the role, the role is free for the next fork. */
  workerExited: (id: number) => void;
  /** Id of the worker holding the role, or null (between its exit and its replacement). */
  holder: () => number | null;
}

export function createSchedulerRole (): SchedulerRole {
  let holderId: number | null = null;
  return {
    fork (fork) {
      const give = holderId == null;
      const id = fork({ [SCHEDULER_ENV]: give ? '1' : '0' });
      if (give) holderId = id;
      return id;
    },
    workerExited (id) {
      if (id === holderId) holderId = null;
    },
    holder: () => holderId
  };
}

/**
 * Worker side: true when this process must run the scheduler. A process that is not a cluster
 * worker (unclustered run, tests) is the only process, so it does.
 *
 * @param isWorker defaults to `cluster.isWorker`; injectable for tests.
 */
export function isSchedulerWorker (
  isWorker: boolean = cluster.isWorker,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (!isWorker) return true;
  return env[SCHEDULER_ENV] === '1';
}
