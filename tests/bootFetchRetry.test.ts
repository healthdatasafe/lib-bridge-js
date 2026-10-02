import assert from 'node:assert/strict';
import { withRetry } from '../src/lib/pryvService.ts';

/**
 * pryvService.init fetched service info and the HDS model once; a transient 'fetch failed'
 * killed every worker at boot (prod bridge-mira, 2026-10-02, B-2026-10-02-3).
 */
describe('[BFRX] boot fetch retry', function () {
  it('[BFR1] succeeds after transient failures and reports each retry with a doubling delay', async () => {
    let calls = 0;
    const retries: Array<[number, number]> = [];
    const result = await withRetry(async () => {
      calls++;
      if (calls < 3) throw new Error('fetch failed');
      return 'infos';
    }, { attempts: 6, delayMs: 5 }, (_err, attempt, delayMs) => retries.push([attempt, delayMs]));
    assert.equal(result, 'infos');
    assert.equal(calls, 3);
    assert.deepEqual(retries, [[1, 5], [2, 10]]);
  });

  it('[BFR2] gives up after the last attempt and rethrows its error', async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(async () => { calls++; throw new Error('still failing ' + calls); }, { attempts: 3, delayMs: 1 }),
      /still failing 3/
    );
    assert.equal(calls, 3);
  });
});
