import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import initBoiler from '../src/initBoiler.ts';
import * as checkAuth from '../src/middlewares/checkAuth.ts';
import userRouter from '../src/routes/userRoute.ts';
import { expressErrorHandler } from '../src/errors/index.ts';

/**
 * Partner-auth enforcement on the `/user` router.
 *
 * Deliberately NOT built through `getApp()`: that initializes the bridge account
 * against a live `bridgeApiEndPoint`, so the whole integration suite skips on a
 * machine without one (see `tests/helpers/testServer.ts#bridgeIsConfigured`). A
 * security regression must not be invisible on those machines, and none of these
 * assertions need Pryv — `assertFromPartner` rejects before any call is made. So
 * we mount the router on a bare app with the same middleware chain `server.ts`
 * uses: `checkIfPartner` (which only SETS `req.isPartner`) plus the error handler.
 */
describe('[USAX] Users — partner auth', function () {
  this.timeout(5000);
  let app: express.Application;
  let partnerToken: string;

  before(async function () {
    const { getConfig } = initBoiler(`bridge-authtest:${process.pid}`);
    const config = await getConfig();
    partnerToken = config.get<string>('partnerAuthToken');
    await checkAuth.init();

    app = express();
    app.use(express.json());
    app.use(checkAuth.checkIfPartner);
    app.use('/user', userRouter);
    app.use(expressErrorHandler);
  });

  /**
   * Regression: `GET /user/list/apiEndPoints` shipped without the
   * `assertFromPartner` its four sibling routes carry, so it served every user's
   * `credentials/pryv-api-endpoint` event — and a Pryv apiEndpoint embeds its auth
   * token — to any caller able to reach the bridge. The router is mounted at
   * `/user` for every framework bridge (`server.ts`), so the exposure was live on
   * each deployed one. Fixed 2026-09-23.
   */
  it('[USAN] GET /user/list/apiEndPoints - rejects a caller with no auth header', async () => {
    const res = await request(app).get('/user/list/apiEndPoints');
    assert.equal(res.status, 401);
    assert.equal(res.body.users, undefined);
  });

  it('[USAB] GET /user/list/apiEndPoints - rejects a wrong partner token', async () => {
    const res = await request(app).get('/user/list/apiEndPoints').set({ authorization: 'not-the-partner-token' });
    assert.equal(res.status, 401);
    assert.equal(res.body.users, undefined);
  });

  it('[USAS] GET /user/:partnerUserId/status - rejects a caller with no auth header', async () => {
    const res = await request(app).get('/user/someone/status');
    assert.equal(res.status, 401);
  });

  it('[USAP] POST /user/:partnerUserId/status - rejects a caller with no auth header', async () => {
    const res = await request(app).post('/user/someone/status').send({ active: false });
    assert.equal(res.status, 401);
  });

  /**
   * The partner token IS accepted — proves these 401s come from the auth gate and
   * not from the bare mount rejecting everything. With a valid token the request
   * gets past `assertFromPartner` and fails later (no bridge account here), so the
   * only thing asserted is "not 401".
   */
  it('[USAV] a valid partner token passes the auth gate', async () => {
    const res = await request(app).get('/user/list/apiEndPoints').set({ authorization: partnerToken });
    assert.notEqual(res.status, 401);
  });
});
