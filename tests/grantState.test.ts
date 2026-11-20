import assert from 'node:assert/strict';
import { pryv } from 'hds-lib';
import { grantState, refusalId } from '../src/lib/grantState.ts';

/**
 * Grant state, lifted from bridge-mira's revokedGrant (its RVK1-3 cases): only the core saying
 * the grant is gone counts as gone; anything else is unknown.
 */

const answering = (answer: () => any) => ({ api: async () => answer() });

describe('[GRST] grantState', function () {
  it('[GRS1] live, gone (revoked or expired), unknown (anything else)', async function () {
    assert.equal(await grantState(answering(() => [{ type: 'app', user: { username: 'alice' } }])), 'live');
    assert.equal(await grantState(answering(() => [{ error: { id: 'invalid-access-token' } }])), 'gone');
    assert.equal(await grantState(answering(() => { throw Object.assign(new Error('x'), { innerObject: { error: { id: 'forbidden' } } }); })), 'gone');
    assert.equal(await grantState(answering(() => { throw new Error('API call result is not an Array: {"error":{"id":"invalid-access-token"}}'); })), 'gone');
    assert.equal(await grantState(answering(() => { throw new Error('fetch failed'); })), 'unknown');
    assert.equal(await grantState(answering(() => [{ error: { id: 'unexpected-error' } }])), 'unknown');
  });

  it('[GRS2] with the real lib-js Connection against a core refusing the token', async function () {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ error: { id: 'invalid-access-token', message: 'Cannot find access from token.' }, meta: { serverTime: Date.now() / 1000 } }),
      { status: 403, headers: { 'content-type': 'application/json' } }
    )) as typeof fetch;
    try {
      assert.equal(await grantState(new pryv.Connection('https://revoked@alice.example/') as any), 'gone');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('[GRS3] refusalId reads the shapes lib-js produces', function () {
    assert.equal(refusalId({ response: { body: { error: { id: 'forbidden' } } } }), 'forbidden');
    assert.equal(refusalId({ id: 'invalid-access-token' }), 'invalid-access-token');
    assert.equal(refusalId(new Error('API call result is not an Array: not json')), null);
    assert.equal(refusalId(null), null);
  });

  it('[GRS4] refusalId reads pryv 3.19 accessInfo() rejections (innerObject is the call error)', function () {
    const e = Object.assign(new Error('Invalid access token'), { innerObject: { id: 'invalid-access-token', message: 'Invalid access token' } });
    assert.equal(refusalId(e), 'invalid-access-token');
    assert.equal(refusalId({ innerObject: { error: { id: 'forbidden' }, id: 'other' } }), 'forbidden');
  });
});
