import boiler from '@pryv/boiler';
import { init as initTestServer, apiTest, partnerAuth, createOnboardedUser, bridgeIsConfigured } from './helpers/testServer.ts';
import SampleBridge from './sample-bridge/index.ts';
import assert from 'node:assert/strict';

const { getConfig } = boiler;

describe('[PLTX] SampleBridge test', () => {
  let mainStreamId: string | null = null;
  before(async function () {
    if (!(await bridgeIsConfigured())) this.skip();
    await initTestServer(new SampleBridge());
    // get the main streamId for the userPermissionRequest servic
    const config = await getConfig();
    const firsStream = (config.get('service:userPermissionRequest') as any[])[0];
    mainStreamId = firsStream.streamId;
  });

  it('[PLTP] Create data POST /data/test/{userId}', async function () {
    this.timeout(3000);
    const userInfos = await createOnboardedUser();
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

    // -- Wait for status to be updated
    await new Promise((resolve) => setTimeout(resolve, 500));
    // -- Check sync status
    const statusRes = await apiTest()
      .get(`/user/${userInfos.partnerUserId}/status`)
      .set(partnerAuth());
    const syncStatus = statusRes.body.syncStatus;
    assert.equal(syncStatus.lastSync, event.modified);
    assert.deepEqual(syncStatus.content, { createdEventId: event.id, pluginVersion: 0 });
  });

  it('[PLTA] Call the API POST /data/test/{userId}/api', async () => {
    const userInfos = await createOnboardedUser();
    // -- Check OK on simple api call
    const apiCalls = [{
      method: 'streams.get',
      params: {}
    }];
    const resultEvents = await apiTest()
      .post(`/data/test/${userInfos.partnerUserId}/api`)
      .set(partnerAuth())
      .send(apiCalls);

    assert.equal(resultEvents.body.length, 1);
    const streams = resultEvents.body[0].streams;
    assert.ok(streams);
    assert.equal(streams[0].id, mainStreamId);
  });
});
