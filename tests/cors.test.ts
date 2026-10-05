import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { corsSettings, corsMiddleware } from '../src/middlewares/cors.ts';

/**
 * `server:corsOrigins` (B-2026-09-24-3): `cors()` used to answer every origin on every
 * bridge. Built on bare express apps, like securityRegressions.test.ts, so it runs without
 * a bridge account.
 */
describe('[CORS] server:corsOrigins', function () {
  const logs: string[] = [];
  const logger = {
    info: (m: string) => { logs.push('info ' + m); },
    warn: (m: string) => { logs.push('warn ' + m); }
  };

  function appWith (value: unknown) {
    const app = express();
    app.use(corsMiddleware(value, logger));
    app.get('/ping', (_req, res) => { res.json({ ok: true }); });
    app.post('/ping', (_req, res) => { res.json({ ok: true }); });
    return app;
  }

  beforeEach(() => { logs.length = 0; });

  it('[CORA] parses the setting', () => {
    assert.deepEqual(corsSettings(undefined), { mode: 'open-default', origins: [] });
    assert.deepEqual(corsSettings(null), { mode: 'open-default', origins: [] });
    assert.deepEqual(corsSettings(' '), { mode: 'open-default', origins: [] });
    assert.deepEqual(corsSettings('*'), { mode: 'open', origins: [] });
    assert.deepEqual(corsSettings(['*']), { mode: 'open', origins: [] });
    assert.deepEqual(corsSettings('["https://app.hds.ngo/home","http://evil.example","https://account.hds.ngo"]'),
      { mode: 'allow-list', origins: ['https://app.hds.ngo', 'https://account.hds.ngo'] });
    assert.deepEqual(corsSettings('https://a.example,https://b.example:8443'),
      { mode: 'allow-list', origins: ['https://a.example', 'https://b.example:8443'] });
    assert.deepEqual(corsSettings([]), { mode: 'allow-list', origins: [] });
  });

  it('[CORB] unset keeps every origin open and warns', async () => {
    const res = await request(appWith(undefined)).get('/ping').set('Origin', 'https://any.example');
    assert.equal(res.headers['access-control-allow-origin'], '*');
    assert.ok(logs.some(l => l.startsWith('warn ')), 'expected a warning');
  });

  it('[CORC] "*" opens explicitly, without a warning', async () => {
    const res = await request(appWith('*')).get('/ping').set('Origin', 'https://any.example');
    assert.equal(res.headers['access-control-allow-origin'], '*');
    assert.ok(!logs.some(l => l.startsWith('warn ')));
  });

  it('[CORD] an allow-list reflects a listed origin and answers its preflight', async () => {
    const app = appWith(['https://app.hds.ngo']);
    const res = await request(app).get('/ping').set('Origin', 'https://app.hds.ngo');
    assert.equal(res.headers['access-control-allow-origin'], 'https://app.hds.ngo');
    assert.match(String(res.headers.vary), /Origin/);

    const pre = await request(app).options('/ping')
      .set('Origin', 'https://app.hds.ngo')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization,content-type');
    assert.equal(pre.status, 204);
    assert.equal(pre.headers['access-control-allow-origin'], 'https://app.hds.ngo');
    assert.match(String(pre.headers['access-control-allow-headers']), /authorization/i);
  });

  it('[CORE] an allow-list gives an unlisted origin no allow header', async () => {
    const app = appWith(['https://app.hds.ngo']);
    for (const origin of ['https://evil.example', 'http://app.hds.ngo', 'https://app.hds.ngo:8443']) {
      const res = await request(app).get('/ping').set('Origin', origin);
      assert.equal(res.headers['access-control-allow-origin'], undefined, origin);
    }
  });

  it('[CORF] requests without Origin (server-to-server) are served normally', async () => {
    const res = await request(appWith(['https://app.hds.ngo'])).post('/ping');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
  });

  it('[CORG] an empty or invalid list refuses every origin and warns', async () => {
    const res = await request(appWith('not-a-url')).get('/ping').set('Origin', 'https://app.hds.ngo');
    assert.equal(res.headers['access-control-allow-origin'], undefined);
    assert.ok(logs.some(l => l.startsWith('warn ')));
  });
});
