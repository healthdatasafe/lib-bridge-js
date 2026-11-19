/**
 * Shared cache abstraction for cluster mode.
 *
 * In cluster mode: uses memored (IPC-based shared cache across workers).
 * In single-process or test mode: uses an in-memory Map.
 *
 * Call `initCacheMaster()` in the master process before forking.
 * Workers can use cacheGet/cacheSet/cacheDel/cacheTake and the leases
 * (cacheLock/cacheRenew/cacheUnlock) immediately.
 */
import memored from 'memored';
import cluster from 'cluster';
import { randomUUID } from 'node:crypto';

let useLocalMap = false;

interface LocalEntry {
  value: unknown;
  expiresAt?: number;
}
const localMap = new Map<string, LocalEntry>();
const LOCAL_SWEEP_INTERVAL_MS = 60_000;
let localSweepTimer: NodeJS.Timeout | undefined;

/**
 * Locks held by the primary in cluster mode, used by `cacheTake` and by the leases
 * (`cacheLock` / `cacheRenew` / `cacheUnlock`). memored has no atomic read-and-remove nor
 * compare-and-set, so the primary hands out a per-key lock with an owner token and a TTL: only
 * the holder of the token can renew or release it, so a holder whose lock expired can never
 * release its successor's. A lock expires on its own if its worker dies.
 *
 * Takes and leases live in separate namespaces of the same table (`take:` / `lease:`), so a
 * lease never blocks a `cacheTake` of the same key.
 */
const TAKE_CHANNEL = 'lib-bridge-js:cache-take';
const TAKE_LOCK_TTL_MS = 30_000;
const TAKE_REPLY_TIMEOUT_MS = 5_000;
const primaryLocks = new Map<string, { token: string, until: number }>();
const pendingReplies = new Map<string, (reply: LockMessage) => void>();
let lockRequestCounter = 0;
let workerListening = false;

/** Same semantics as `primaryLocks`, for local (single-process) mode. */
const localLocks = new Map<string, { token: string, until: number }>();

interface LockMessage {
  channel: typeof TAKE_CHANNEL;
  op: 'lock' | 'unlock' | 'renew' | 'reply';
  key: string;
  id?: string;
  token?: string;
  ttlMs?: number;
  granted?: boolean;
}

function isLockMessage (msg: unknown): msg is LockMessage {
  return (msg as LockMessage)?.channel === TAKE_CHANNEL;
}

function assertTtl (ttlMs: number): void {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error(`cache lock: ttlMs must be a positive number, got ${ttlMs}`);
}

/**
 * The lock table logic, shared by the primary (cluster) and local mode. Expired locks are
 * swept first, so an expired lock can neither be renewed nor released, and is free to take.
 */
function applyLockOp (
  locks: Map<string, { token: string, until: number }>,
  op: 'lock' | 'unlock' | 'renew', key: string, ttlMs: number, token?: string
): { granted: boolean, token?: string } {
  const now = Date.now();
  for (const [k, l] of locks) {
    if (l.until <= now) locks.delete(k);
  }
  const held = locks.get(key);
  if (op === 'lock') {
    if (held != null) return { granted: false };
    const newToken = randomUUID();
    locks.set(key, { token: newToken, until: now + ttlMs });
    return { granted: true, token: newToken };
  }
  if (held == null || token == null || held.token !== token) return { granted: false };
  if (op === 'unlock') {
    locks.delete(key);
  } else {
    held.until = now + ttlMs;
  }
  return { granted: true };
}

/** Exported for tests: the primary's handler of lock messages from workers. */
export function onTakeMessageInPrimary (worker: { send: (msg: unknown) => boolean }, msg: unknown): void {
  if (!isLockMessage(msg) || msg.op === 'reply') return;
  const ttlMs = typeof msg.ttlMs === 'number' && msg.ttlMs > 0 ? msg.ttlMs : TAKE_LOCK_TTL_MS;
  const res = applyLockOp(primaryLocks, msg.op, msg.key, ttlMs, msg.token);
  if (msg.id == null) return; // fire-and-forget unlock
  worker.send({ channel: TAKE_CHANNEL, op: 'reply', key: msg.key, id: msg.id, granted: res.granted, token: res.token });
}

function askPrimary (msg: Omit<LockMessage, 'channel' | 'id'>): Promise<LockMessage> {
  if (!workerListening) {
    process.on('message', (reply: unknown) => {
      if (!isLockMessage(reply) || reply.op !== 'reply' || reply.id == null) return;
      const resolve = pendingReplies.get(reply.id);
      if (resolve == null) return;
      pendingReplies.delete(reply.id);
      resolve(reply);
    });
    workerListening = true;
  }
  const id = `${process.pid}:${++lockRequestCounter}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingReplies.delete(id);
      reject(new Error(`cache lock: no reply from the primary within ${TAKE_REPLY_TIMEOUT_MS} ms (initCacheMaster not called?)`));
    }, TAKE_REPLY_TIMEOUT_MS);
    pendingReplies.set(id, (reply) => {
      clearTimeout(timer);
      resolve(reply);
    });
    process.send!({ ...msg, channel: TAKE_CHANNEL, id });
  });
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
  const lockKey = 'take:' + key;
  const lock = await askPrimary({ op: 'lock', key: lockKey, ttlMs: TAKE_LOCK_TTL_MS });
  if (lock.granted !== true || lock.token == null) return undefined;
  try {
    const value = await cacheGet<T>(key);
    if (value !== undefined) await cacheDel(key);
    return value;
  } finally {
    process.send!({ channel: TAKE_CHANNEL, op: 'unlock', key: lockKey, token: lock.token });
  }
}

/**
 * Take a lease on `key` for `ttlMs`, across workers. Returns the owner token, or null when
 * another holder has it. Hold it with `cacheRenew` before `ttlMs` elapses; release it with
 * `cacheUnlock`. An expired lease is free for the next caller, and its old token is dead.
 */
export async function cacheLock (key: string, ttlMs: number): Promise<string | null> {
  assertTtl(ttlMs);
  if (isLocal()) return applyLockOp(localLocks, 'lock', 'lease:' + key, ttlMs).token ?? null;
  const reply = await askPrimary({ op: 'lock', key: 'lease:' + key, ttlMs });
  return reply.granted === true && reply.token != null ? reply.token : null;
}

/** Extend a held lease to `ttlMs` from now. False when `token` no longer holds it (expired or released). */
export async function cacheRenew (key: string, token: string, ttlMs: number): Promise<boolean> {
  assertTtl(ttlMs);
  if (isLocal()) return applyLockOp(localLocks, 'renew', 'lease:' + key, ttlMs, token).granted;
  const reply = await askPrimary({ op: 'renew', key: 'lease:' + key, token, ttlMs });
  return reply.granted === true;
}

/** Release a lease, only when `token` still holds it. Returns whether it did. */
export async function cacheUnlock (key: string, token: string): Promise<boolean> {
  if (isLocal()) return applyLockOp(localLocks, 'unlock', 'lease:' + key, 0, token).granted;
  const reply = await askPrimary({ op: 'unlock', key: 'lease:' + key, token });
  return reply.granted === true;
}
