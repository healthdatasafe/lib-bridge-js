import initBoiler from './initBoiler.ts';
import cluster from 'cluster';
import os from 'os';
import * as server from './server.ts';
import type PluginBridge from './lib/PluginBridge.ts';
import { initCacheMaster } from './lib/cache.ts';
import { createCrashLoopMonitor, type CrashLoopIncident } from './lib/crashLoopMonitor.ts';
import { createSchedulerRole } from './lib/schedulerRole.ts';

// New Relic APM agent removed (plan 88): no vendor SDK runs in the process.
// Crash-loops are now detected by the host collector's container-uptime metric
// (`container.uptime`, alert condition 15120471); this master only logs the
// incident locally and, on escalation, exits so the orchestrator marks the app
// down. Per-request telemetry is emitted by `hds-observability-js` in the
// workers (see `server.ts`).

function incidentAttrs (incident: CrashLoopIncident): Record<string, string | number> {
  return {
    exitHistory: JSON.stringify(incident.exitHistory),
    lastExitCode: incident.lastExitCode ?? -1,
    lastExitSignal: incident.lastExitSignal ?? 'none',
    loopCount: incident.loopCount,
    windowMs: incident.windowMs
  };
}

/**
 * Start the bridge with clustering.
 * @param plugin - Plugin instance to use (optional for backward compat)
 * @param configDir - Path to consumer's config/ directory (optional)
 */
export default async function startCluster (plugin?: PluginBridge, configDir?: string): Promise<void> {
  const { getConfig, getLogger } = initBoiler(`bridge:${process.pid}`, configDir);
  const numCPUs = os.cpus().length;
  const logger = getLogger('start');

  const config = await getConfig();
  if (cluster.isPrimary) {
    initCacheMaster();
    logger.info(`Master process ${process.pid} is running`);
    const configNumProcesses = config.get<number>('start:numProcesses') || numCPUs;
    const numProcesses = configNumProcesses < 0 ? Math.max(numCPUs + configNumProcesses, 1) : configNumProcesses;
    const exitOnCrashLoop = config.get<boolean>('start:exitOnCrashLoop') === true;
    // One live worker holds the scheduler role; its replacement inherits it (see schedulerRole.ts).
    const schedulerRole = createSchedulerRole();
    const forkWorker = (): number => schedulerRole.fork((env) => cluster.fork(env).id);

    const monitor = createCrashLoopMonitor({
      exitOnCrashLoop,
      now: () => Date.now(),
      setTimer: (fn, ms, keepAlive) => {
        const handle = setTimeout(fn, ms);
        // Healthy timers (keepAlive falsy) are unref'd — a live worker's IPC handle
        // already refs the loop. Refork/escalation timers (keepAlive true) must NOT
        // be unref'd: when the whole fleet is dead they are the only live handle, and
        // unref'ing them makes the master fall off the event loop and exit 0.
        if (keepAlive !== true) handle.unref();
        return handle;
      },
      clearTimer: (handle) => { clearTimeout(handle as NodeJS.Timeout); },
      onFork: () => {
        monitor.workerForked(forkWorker());
      },
      onNoticeError: (incident) => {
        logger.error(
          `Cluster crash-loop detected: ${incident.loopCount} crashes in ${incident.windowMs}ms`,
          incidentAttrs(incident)
        );
      },
      onEscalate: (incident) => {
        logger.error(
          `Crash-loop escalation: exiting master ${process.pid} so the orchestrator marks the app down`,
          incidentAttrs(incident)
        );
        process.exit(1);
      },
      logger: {
        info: (m) => logger.info(m),
        warn: (m) => logger.warn(m),
        error: (m) => logger.error(m)
      }
    });

    // Graceful termination on an intentional stop/restart. Registering a handler
    // overrides Node's default terminate, so we must actually tear down and exit:
    // stop reforking (cancels any pending backoff/escalation timer), forward the
    // signal to workers, then exit cleanly. `once` so a repeated signal can't re-enter.
    const onSignal = (signal: NodeJS.Signals): void => {
      const workers = cluster.workers ?? {};
      logger.info(`Master ${process.pid} received ${signal}; stopping ${Object.keys(workers).length} worker(s) and exiting`);
      monitor.shutdown();
      for (const worker of Object.values(workers)) worker?.process.kill(signal);
      process.exit(0);
    };
    process.once('SIGTERM', () => onSignal('SIGTERM'));
    process.once('SIGINT', () => onSignal('SIGINT'));

    for (let i = 0; i < numProcesses; i++) {
      monitor.workerForked(forkWorker());
    }

    cluster.on('exit', (worker, code, signal) => {
      // Free the role BEFORE the monitor reforks, so the replacement inherits it.
      schedulerRole.workerExited(worker.id);
      monitor.workerExited(worker.id, code, signal, worker.exitedAfterDisconnect === true);
    });
  } else {
    await server.launch(plugin);
    // Accept both the lib convention (`baseURL`) and the bridge convention
    // (`baseUrl`, used by bridge-mira for its OAuth redirect_uri) so the exposed
    // URL resolves whichever casing the consumer configured.
    const exposedUrl = config.get('baseURL') ?? config.get('baseUrl');
    logger.info(`Api is exposed on: ${exposedUrl ?? '(baseURL/baseUrl not configured)'}`);
  }
}

// Legacy auto-run removed — consumers must call startCluster() explicitly from their own start.ts
