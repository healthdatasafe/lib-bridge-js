import { cacheSet, cacheTake, cacheLock, cacheRenew, cacheUnlock } from '../../src/lib/cache.ts';

/**
 * Cluster worker for tests/cache.test.ts: sets, takes or leases a cache key on command from the primary.
 */
process.on('message', async (msg: any) => {
  if (msg?.cmd === 'set') {
    await cacheSet(msg.key, msg.value, msg.ttlMs);
    process.send!({ cmd: 'set-done' });
  } else if (msg?.cmd === 'take') {
    const value = await cacheTake(msg.key);
    process.send!({ cmd: 'taken', value: value ?? null });
  } else if (msg?.cmd === 'lock') {
    process.send!({ cmd: 'locked', token: await cacheLock(msg.key, msg.ttlMs) });
  } else if (msg?.cmd === 'renew') {
    process.send!({ cmd: 'renewed', ok: await cacheRenew(msg.key, msg.token, msg.ttlMs) });
  } else if (msg?.cmd === 'unlock') {
    process.send!({ cmd: 'unlocked', ok: await cacheUnlock(msg.key, msg.token) });
  }
});
process.send!({ cmd: 'ready' });
