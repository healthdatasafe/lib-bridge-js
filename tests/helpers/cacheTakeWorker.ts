import { cacheSet, cacheTake } from '../../src/lib/cache.ts';

/**
 * Cluster worker for tests/cache.test.ts: sets or takes a cache key on command from the primary.
 */
process.on('message', async (msg: any) => {
  if (msg?.cmd === 'set') {
    await cacheSet(msg.key, msg.value, msg.ttlMs);
    process.send!({ cmd: 'set-done' });
  } else if (msg?.cmd === 'take') {
    const value = await cacheTake(msg.key);
    process.send!({ cmd: 'taken', value: value ?? null });
  }
});
process.send!({ cmd: 'ready' });
