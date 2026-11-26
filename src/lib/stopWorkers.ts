/**
 * Graceful stop of the cluster's workers (B-2026-11-25-18). The master is the container's PID 1: when it exits, the
 * container ends and every worker with it, whatever the orchestrator's stop timeout. So on SIGTERM / SIGINT the master
 * forwards the signal, then waits for its workers to exit, at most `timeoutMs`, and kills those still running.
 *
 * A worker that does nothing on the signal exits at once (Node's default), so nothing changes for it. A worker that
 * handles it (stops taking jobs, finishes the one running, then exits) now gets that time. Keep `timeoutMs` below the
 * orchestrator's stop timeout (Docker's default is 10 s), or it kills the container first.
 */

/** The part of a cluster worker this uses */
export interface StoppableWorker {
  isDead (): boolean;
  once (event: 'exit', listener: () => void): unknown;
  process: { kill (signal?: NodeJS.Signals | number): boolean };
}

/** Code default of `start:shutdownTimeoutMs` (a bridge's own default-config.yml replaces the library's file) */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 8000;

/** Resolves once every worker has exited (`killed`: how many were still running at `timeoutMs` and got SIGKILL) */
export function stopWorkers (workers: StoppableWorker[], signal: NodeJS.Signals, timeoutMs: number): Promise<{ killed: number }> {
  const live = workers.filter(w => !w.isDead());
  for (const w of live) {
    try { w.process.kill(signal); } catch { /* already gone */ }
  }
  if (live.length === 0) return Promise.resolve({ killed: 0 });
  return new Promise(resolve => {
    let pending = live.length;
    let done = false;
    const finish = (killed: number): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ killed });
    };
    const timer = setTimeout(() => {
      const left = live.filter(w => !w.isDead());
      for (const w of left) {
        try { w.process.kill('SIGKILL'); } catch { /* already gone */ }
      }
      finish(left.length);
    }, Math.max(0, timeoutMs));
    for (const w of live) {
      w.once('exit', () => {
        pending--;
        if (pending === 0) finish(0);
      });
    }
  });
}
