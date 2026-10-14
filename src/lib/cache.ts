/**
 * Shared cache abstraction for cluster mode.
 *
 * In cluster mode: uses memored (IPC-based shared cache across workers).
 * In single-process or test mode: uses an in-memory Map.
 *
 * Call `initCacheMaster()` in the master process before forking.
 * Workers can use cacheGet/cacheSet/cacheDel/cacheTake immediately.
 */
import memored from 'memored';
import cluster from 'cluster';

let useLocalMap = false;

interface LocalEntry {
  value: unknown;
  expiresAt?: number;
}
const localMap = new Map<string, LocalEntry>();
const LOCAL_SWEEP_INTERVAL_MS = 60_000;
let localSweepTimer: NodeJS.Timeout | undefined;

/**
 * cacheTake in cluster mode: memored has no atomic read-and-remove, so the primary hands out a
 * per-key lock and only the holder reads and removes the value. The lock expires on its own if
 * its worker dies mid-take.
 */
const TAKE_CHANNEL = 'lib-bridge-js:cache-take';
const TAKE_LOCK_TTL_MS = 30_000;
const TAKE_REPLY_TIMEOUT_MS = 5_000;
const takeLocks = new Map<string, number>();
const pendingTakeLocks = new Map<string, (granted: boolean) => void>();
let takeRequestCounter = 0;
let workerListening = false;

interface TakeMessage {
  channel: typeof TAKE_CHANNEL;
  op: 'lock' | 'unlock';
  key: string;
  id?: string;
  granted?: boolean;
}

function isTakeMessage (msg: unknown): msg is TakeMessage {
  return (msg as TakeMessage)?.channel === TAKE_CHANNEL;
}

function onTakeMessageInPrimary (worker: { send: (msg: unknown) => boolean }, msg: unknown): void {
  if (!isTakeMessage(msg)) return;
  const now = Date.now();
  for (const [key, until] of takeLocks) {
    if (until <= now) takeLocks.delete(key);
  }
  if (msg.op === 'unlock') {
    takeLocks.delete(msg.key);
    return;
  }
  const granted = !takeLocks.has(msg.key);
  if (granted) takeLocks.set(msg.key, now + TAKE_LOCK_TTL_MS);
  worker.send({ channel: TAKE_CHANNEL, op: 'lock', key: msg.key, id: msg.id, granted });
}

function requestTakeLock (key: string): Promise<boolean> {
  if (!workerListening) {
    process.on('message', (msg: unknown) => {
      if (!isTakeMessage(msg) || msg.id == null) return;
      const resolve = pendingTakeLocks.get(msg.id);
      if (resolve == null) return;
      pendingTakeLocks.delete(msg.id);
      resolve(msg.granted === true);
    });
    workerListening = true;
  }
  const id = `${process.pid}:${++takeRequestCounter}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingTakeLocks.delete(id);
      reject(new Error(`cacheTake: no lock reply from the primary within ${TAKE_REPLY_TIMEOUT_MS} ms (initCacheMaster not called?)`));
    }, TAKE_REPLY_TIMEOUT_MS);
    pendingTakeLocks.set(id, (granted) => {
      clearTimeout(timer);
      resolve(granted);
    });
    process.send!({ channel: TAKE_CHANNEL, op: 'lock', key, id });
  });
}

function releaseTakeLock (key: string): void {
  process.send!({ channel: TAKE_CHANNEL, op: 'unlock', key });
}

/**
 * Initialize cache in master process. Must be called before forking workers.
 */
export function initCacheMaster (): void {
  if (cluster.isPrimary) {
    memored.setup({ purgeInterval: 1500 });
    cluster.on('message', onTakeMessageInPrimary);
  }
}

/**
 * Force local-only mode (for single-process or test).
 */
export function initCacheLocal (): void {
  useLocalMap = true;
}

function isLocal (): boolean {
  return useLocalMap || !cluster.isWorker;
}

function sweepLocal (): void {
  const now = Date.now();
  for (const [key, entry] of localMap) {
    if (entry.expiresAt != null && entry.expiresAt <= now) localMap.delete(key);
  }
}

function localGet (key: string): unknown {
  const entry = localMap.get(key);
  if (entry == null) return undefined;
  if (entry.expiresAt != null && entry.expiresAt <= Date.now()) {
    localMap.delete(key);
    return undefined;
  }
  return entry.value;
}

/**
 * Store a value in the shared cache. A positive `ttlMs` expires the entry after that many
 * milliseconds; without one (or with 0, as memored treats it) the entry never expires.
 */
export async function cacheSet (key: string, value: unknown, ttlMs?: number): Promise<void> {
  if (isLocal()) {
    const expiresAt = ttlMs != null && ttlMs > 0 ? Date.now() + ttlMs : undefined;
    localMap.set(key, { value, expiresAt });
    if (expiresAt != null && localSweepTimer == null) {
      localSweepTimer = setInterval(sweepLocal, LOCAL_SWEEP_INTERVAL_MS).unref();
    }
    return;
  }
  return new Promise((resolve, reject) => {
    const cb = (err: Error | null) => {
      if (err) return reject(err);
      resolve();
    };
    if (ttlMs != null) {
      memored.store(key, value, ttlMs, cb);
    } else {
      memored.store(key, value, cb);
    }
  });
}

/**
 * Get a value from the shared cache.
 */
export async function cacheGet<T = unknown> (key: string): Promise<T | undefined> {
  if (isLocal()) {
    return localGet(key) as T | undefined;
  }
  return new Promise((resolve, reject) => {
    memored.read(key, (err, value) => {
      if (err) return reject(err);
      resolve(value as T | undefined);
    });
  });
}

/**
 * Delete a value from the shared cache.
 */
export async function cacheDel (key: string): Promise<void> {
  if (isLocal()) {
    localMap.delete(key);
    return;
  }
  return new Promise((resolve, reject) => {
    memored.remove(key, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

/**
 * Read a value and remove it in one step: of several concurrent callers for the same key, across
 * workers, only one gets the value; the others get `undefined`. Use it for single-use entries
 * such as an OAuth `state`.
 */
export async function cacheTake<T = unknown> (key: string): Promise<T | undefined> {
  if (isLocal()) {
    const value = localGet(key) as T | undefined;
    localMap.delete(key);
    return value;
  }
  if (!await requestTakeLock(key)) return undefined;
  try {
    const value = await cacheGet<T>(key);
    if (value !== undefined) await cacheDel(key);
    return value;
  } finally {
    releaseTakeLock(key);
  }
}
