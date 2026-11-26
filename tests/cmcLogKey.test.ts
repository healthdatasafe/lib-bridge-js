import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { logKey } from '../src/cmc/logKey.ts';

/** B-2026-11-24-8: a CMC log line or error names a relationship by a hash, never by its key (which holds a username). */
describe('[CLK] CMC relationship keys in logs', () => {
  it('[CLK1] logKey is a short stable hash, the HDS Reader engine\'s', () => {
    const key = 'alice--demo.datasafe.dev';
    assert.match(logKey(key), /^[0-9a-f]{12}$/);
    assert.equal(logKey(key), logKey(key));
    assert.notEqual(logKey(key), logKey('bob--demo.datasafe.dev'));
    assert.equal(logKey(key), createHash('sha256').update('log|' + key).digest('hex').slice(0, 12));
    assert.ok(!logKey(key).includes('alice'));
  });

  it('[CLK2] no log call or error of src/cmc interpolates a raw userKey', () => {
    const dir = new URL('../src/cmc/', import.meta.url);
    const raw = /\$\{(?:[a-zA-Z]+\.)?userKey\}/;
    const offenders: string[] = [];
    for (const file of readdirSync(dir).filter(f => f.endsWith('.ts'))) {
      readFileSync(new URL(file, dir), 'utf8').split('\n').forEach((line, i) => {
        if (/logger\.|Error\(/.test(line) && raw.test(line)) offenders.push(`${file}:${i + 1}`);
      });
    }
    assert.deepEqual(offenders, []);
  });
});
