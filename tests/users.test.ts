import assert from 'node:assert/strict';
import { init as initTestServer, apiTest, partnerAuth, createOnboardedUser, bridgeIsConfigured } from './helpers/testServer.ts';
import ShortUniqueId from 'short-unique-id';
import boiler from '@pryv/boiler';
const { getConfig } = boiler;

describe('[USEX] Users', function () {
  this.timeout(5000);
  const testRnd = (new ShortUniqueId({ dictionary: 'alphanum_lower', length: 8 })).rnd();
  let mainStreamId: string | null = null;

  before(async function () {
    if (!(await bridgeIsConfigured())) this.skip();
    await initTestServer();
    // get the main streamId for the userPermissionRequest servic
    const config = await getConfig();
    const firsStream = (config.get('service:userPermissionRequest') as any[])[0];
    mainStreamId = firsStream.streamId;
  });

  it('[USEL] GET /user/list/apiEndpoints', async () => {
    const result = await apiTest().get('/user/list/apiEndpoints').set(partnerAuth());
    assert.equal(result.status, 200);
    assert.ok(result.body.users.length > 0);
  });

  it('[USEU] GET /user/:userId:/status - Unkown User', async () => {
    const result = await apiTest().get(`/user/${testRnd}/status`).set(partnerAuth());
    assert.equal(result.status, 404);
    assert.deepEqual(result.body, {
      error: 'Ressource not found: Unkown user',
      errorObject: { userId: testRnd }
    });
  });

  it('[USEA] GET /user/:userId:/status - Active User', async () => {
    const userInfos = await createOnboardedUser();
    const result = await apiTest()
      .get(`/user/${userInfos.partnerUserId}/status`)
      .set(partnerAuth());

    assert.equal(result.status, 200);
    const status = result.body;
    const expectedStatus = {
      user: {
        active: true,
        partnerUserId: userInfos.partnerUserId,
        apiEndpoint: userInfos.appApiEndpoint,
        created: status.user.created,
        modified: status.user.modified
      },
      syncStatus: { }
    };
    assert.deepEqual(status, expectedStatus);

    // -- Check OK on post data
    const newData = [{
      type: 'note/txt',
      content: 'Hello world'
    }];
    const resultEvents = await apiTest()
      .post(`/data/test/${userInfos.partnerUserId}`)
      .set(partnerAuth())
      .send(newData);

    assert.equal(resultEvents.body.length, 1);
    const event = resultEvents.body[0].event;
    assert.ok(event);
    assert.equal(event.type, 'note/txt');
    assert.equal(event.content, 'Hello world');
    // Pryv events carry `streamIds` (plural); the deprecated singular is no
    // longer echoed by open-pryv.io 2.x.
    assert.ok(event.streamIds.includes(mainStreamId));
  });

  it('[USEI] GET /user/:userId:/status - Inactive User', async () => {
    const userInfos = await createOnboardedUser();

    // deactivate the user
    const resultInactive = await apiTest()
      .post(`/user/${userInfos.partnerUserId}/status`)
      .set(partnerAuth())
      .send({ active: false });

    assert.equal(resultInactive.status, 200);
    assert.deepEqual(resultInactive.body, { active: false });

    // check the status
    const result = await apiTest()
      .get(`/user/${userInfos.partnerUserId}/status`)
      .set(partnerAuth());
    assert.equal(result.status, 200);
    const status = result.body;
    const expectedStatus = {
      user: {
        active: false,
        partnerUserId: userInfos.partnerUserId,
        apiEndpoint: userInfos.appApiEndpoint,
        created: status.user.created,
        modified: status.user.modified
      },
      syncStatus: { }
    };
    assert.deepEqual(status, expectedStatus);

    // -- Check error on post data
    const newData = [{
      type: 'note/txt',
      content: 'Hello world'
    }];
    const resultEvents = await apiTest()
      .post(`/data/test/${userInfos.partnerUserId}`)
      .set(partnerAuth())
      .send(newData);

    assert.equal(resultEvents.status, 400);
    assert.deepEqual(resultEvents.body, {
      error: 'Bad request: Deactivated User',
      errorObject: { userId: userInfos.partnerUserId }
    });
  });
});
