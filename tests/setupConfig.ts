import fs from 'node:fs';
import path from 'node:path';

// Loaded by `npm test` through mocha's `--require`, before any suite.
// The bridge config file goes to dev-boiler through its `config` key, read from the
// environment, never as a `--config` argument: mocha takes `--config` for its own rc file,
// so the old `-- --config localConfig.yml` made mocha parse the bridge config (and abort when
// the file was absent). `config=<path> npm test` picks a file; otherwise the repo's
// `localConfig.yml` is used when present, and without it only config/test-config.yml applies,
// in which case the suites needing a bridge account skip.
const localConfig = path.resolve(import.meta.dirname, '../localConfig.yml');
if (process.env.config == null && fs.existsSync(localConfig)) process.env.config = localConfig;
// A Node flag on the mocha command line (`--test-reporter=spec` was one) makes mocha re-spawn
// itself with `--no-config`, which dev-boiler reads as `config: false` over the environment:
// the bridge config is then silently dropped and the live suites skip. Fail instead.
if (process.env.config != null && process.argv.includes('--no-config')) {
  throw new Error('mocha re-spawned with --no-config (a Node flag in the mocha command?): the bridge config would be ignored');
}
