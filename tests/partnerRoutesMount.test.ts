import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { listenLocal } from './helpers/localServer.ts';
import initBoiler from '../src/initBoiler.ts';
import { mountPartnerRoutes } from '../src/server.ts';
import { expressErrorHandler } from '../src/errors/index.ts';

/**
 * B-2026-10-14-6: the legacy partner-onboarding routes are mounted only on a bridge that has a
 * partner backend (`partnerAuthToken` configured). Bare express apps, as in
 * `userRouteAuth.test.ts`: the full app needs a live `bridgeApiEndPoint`.
 */
describe('[PRMX] partner onboarding routes mount', function () {
  before(function () {
    initBoiler(`bridge-prmtest:${process.pid}`);
  });

  async function appWith (enabled: boolean) {
    const app = express();
    const mounted = mountPartnerRoutes(app, enabled);
    app.use(expressErrorHandler);
    return { mounted, server: await listenLocal(app) };
  }

  it('[PRMA] without a partner token nothing is mounted: the anonymous finalize route and /account answer 404', async () => {
    const { mounted, server } = await appWith(false);
    assert.equal(mounted, false);
    assert.equal((await request(server).get('/user/onboard/finalize/someuser?prYvpoll=https://example.invalid/x')).status, 404);
    assert.equal((await request(server).post('/user/onboard/').send({})).status, 404);
    assert.equal((await request(server).get('/account/errors/')).status, 404);
    assert.equal((await request(server).get('/static/onboardPatientByCareGiver.html')).status, 404);
  });

  it('[PRMB] with a partner token the routes are mounted and still refuse a non-partner caller', async () => {
    const { mounted, server } = await appWith(true);
    assert.equal(mounted, true);
    assert.equal((await request(server).get('/account/errors/')).status, 401);
    assert.equal((await request(server).post('/user/onboard/').send({})).status, 401);
  });
});
