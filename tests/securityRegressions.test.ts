import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import initBoiler from '../src/initBoiler.ts';
import userRouter from '../src/routes/userRoute.ts';
import { expressErrorHandler, badRequest, internalError, serviceError } from '../src/errors/index.ts';
import type { AppError } from '../src/errors/index.ts';

/**
 * Regressions for two findings of the 2026-09-23 security audit.
 *
 * Built on bare express apps rather than `getApp()`, as `userRouteAuth.test.ts` is: the
 * full app needs a live `bridgeApiEndPoint`, and a security regression must not be
 * invisible on machines without one.
 */
describe('[SECX] security regressions', function () {
  this.timeout(5000);

  before(function () {
    initBoiler(`bridge-sectest:${process.pid}`);
  });

  /**
   * M2 — `GET /user/onboard/finalize/:partnerUserId` is anonymous and fetched `prYvpoll`
   * straight off the query string before matching it against a pending request: blind
   * SSRF from every deployed bridge. The fetch must come after the match. Here no bridge
   * account is initialized, so the pending-request lookup fails and the route errors out;
   * what matters is that the attacker's URL was never requested.
   */
  it('[SECS] onboard/finalize never fetches an unmatched prYvpoll URL', async () => {
    let hits = 0;
    const probe = http.createServer((_req, res) => {
      hits++;
      res.setHeader('Content-Type', 'application/json');
      res.end('{}');
    });
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address() as AddressInfo;
    try {
      const app = express();
      app.use('/user', userRouter);
      app.use(expressErrorHandler);
      await request(app).get(`/user/onboard/finalize/victim-user?prYvpoll=${encodeURIComponent(`http://127.0.0.1:${port}/internal`)}`);
      assert.equal(hits, 0, 'the bridge requested an attacker-chosen URL before matching it to a pending onboarding');
    } finally {
      await new Promise<void>((resolve) => probe.close(() => resolve()));
    }
  });

  /**
   * M3 — `expressErrorHandler` sent `err.errorObject` to the client whatever the status,
   * so on a 5xx it serialized whatever internal object the throwing code had attached.
   */
  describe('[SECE] expressErrorHandler and errorObject', function () {
    const app = express();
    app.get('/bad', () => badRequest('nope', { field: 'x' }));
    app.get('/internal', () => internalError('boom', { secret: 'internal-detail' }));
    app.get('/service', () => serviceError('upstream', { upstreamBody: 'internal-detail' }));
    app.get('/plain', () => {
      const e: AppError = new Error('no status');
      e.errorObject = { secret: 'internal-detail' };
      throw e;
    });
    app.use(expressErrorHandler);

    it('[SECB] a 4xx keeps its errorObject (deliberate client-facing detail)', async () => {
      const res = await request(app).get('/bad');
      assert.equal(res.status, 400);
      assert.deepEqual(res.body.errorObject, { field: 'x' });
    });

    for (const path of ['/internal', '/service', '/plain']) {
      it(`[SECI] a 5xx does not send errorObject (${path})`, async () => {
        const res = await request(app).get(path);
        assert.ok(res.status >= 500, `expected a 5xx, got ${res.status}`);
        assert.equal(res.body.errorObject, undefined);
        assert.ok(!JSON.stringify(res.body).includes('internal-detail'));
        assert.ok(typeof res.body.error === 'string');
      });
    }
  });
});
