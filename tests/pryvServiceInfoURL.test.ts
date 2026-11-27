import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const probe = path.resolve(import.meta.dirname, 'helpers/serviceInfoProbe.ts');

/**
 * pryvService.init() built its HDSService from `service:serviceInfoURL`, but hds-lib's initHDSModel()
 * builds its own from hds-lib's default (production) service info URL: the model and converter
 * packs came from that service, whatever platform the bridge was configured for (B-2026-11-27-14).
 */
describe('[PSIX] pryvService.init loads the HDS model from service:serviceInfoURL', function () {
  this.timeout(20000);

  it('[PSI1] fetches only the configured service info and loads the model from its hds-model asset', async () => {
    const configured = 'https://configured.datasafe.test/reg/service/info';
    const { stdout } = await run(process.execPath, [probe, configured], { env: { ...process.env, NODE_ENV: 'test' } });
    const line = stdout.split('\n').find((l) => l.startsWith('PROBE:'));
    assert.ok(line, 'probe printed no result:\n' + stdout);
    const { requested, modelUrl } = JSON.parse(line.slice('PROBE:'.length));
    assert.equal(modelUrl, 'https://configured.datasafe.test/model/pack.json');
    assert.deepEqual(requested.filter((u: string) => u.endsWith('/service/info')).filter((u: string) => u !== configured), []);
  });
});
