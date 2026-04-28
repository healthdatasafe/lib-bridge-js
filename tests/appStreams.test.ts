import assert from 'node:assert/strict';
import { ensureAppStreamsTree } from '../src/lib/appStreams.ts';

/** Mock Pryv connection that records api calls and returns a configurable result. */
function mockConn (results: Array<{ stream?: { id: string, name: string }, error?: { id: string } }>): any {
  const calls: any[] = [];
  return {
    calls,
    async api (apiCalls: any[]) {
      calls.push(...apiCalls);
      return results;
    }
  };
}

describe('[APSX] ensureAppStreamsTree (Plan 25 / Plan 45 Phase 9)', function () {
  it('[APS1] creates root only when no substreams declared', async () => {
    const conn = mockConn([{ stream: { id: 'foo-app', name: 'foo App' } }]);
    const r = await ensureAppStreamsTree(conn, { appId: 'foo' });
    assert.equal(r.appStreamId, 'foo-app');
    assert.deepEqual(r.subStreamIds, {});
    assert.equal(conn.calls.length, 1);
    assert.equal(conn.calls[0].method, 'streams.create');
    assert.equal(conn.calls[0].params.id, 'foo-app');
    assert.equal(conn.calls[0].params.name, 'foo App');
    assert.equal(conn.calls[0].params.parentId, undefined);
  });

  it('[APS2] honours parentId option', async () => {
    const conn = mockConn([{ stream: { id: 'foo-app', name: 'foo App' } }]);
    await ensureAppStreamsTree(conn, { appId: 'foo', parentId: 'foo' });
    assert.equal(conn.calls[0].params.parentId, 'foo');
  });

  it('[APS3] honours custom baseName', async () => {
    const conn = mockConn([{ stream: { id: 'foo-app', name: 'Custom Name' } }]);
    await ensureAppStreamsTree(conn, { appId: 'foo', baseName: 'Custom Name' });
    assert.equal(conn.calls[0].params.name, 'Custom Name');
  });

  it('[APS4] creates root + each substream with correct full id', async () => {
    const conn = mockConn([
      { stream: { id: 'bridge-mira-app', name: 'Mira App' } },
      { stream: { id: 'bridge-mira-app-notes', name: 'Notes' } },
      { stream: { id: 'bridge-mira-app-chat', name: 'Chat' } }
    ]);
    const r = await ensureAppStreamsTree(conn, {
      appId: 'bridge-mira',
      baseName: 'Mira App',
      parentId: 'bridge-mira',
      subStreams: [
        { suffix: 'notes', name: 'Notes' },
        { suffix: 'chat', name: 'Chat' }
      ]
    });
    assert.equal(r.appStreamId, 'bridge-mira-app');
    assert.deepEqual(r.subStreamIds, {
      notes: 'bridge-mira-app-notes',
      chat: 'bridge-mira-app-chat'
    });
    assert.equal(conn.calls.length, 3);
    assert.equal(conn.calls[1].params.id, 'bridge-mira-app-notes');
    assert.equal(conn.calls[1].params.parentId, 'bridge-mira-app');
    assert.equal(conn.calls[2].params.id, 'bridge-mira-app-chat');
  });

  it('[APS5] passes substream clientData through (e.g. hdsCustomField)', async () => {
    const conn = mockConn([
      { stream: { id: 'study-app', name: 'study App' } },
      { stream: { id: 'study-app-comments', name: 'Comments' } }
    ]);
    await ensureAppStreamsTree(conn, {
      appId: 'study',
      subStreams: [
        {
          suffix: 'comments',
          name: 'Comments',
          clientData: { hdsCustomField: { 'note/txt': { version: 'v1', templateId: 'study', key: 'cmt', label: { en: 'cmt' } } } }
        }
      ]
    });
    assert.deepEqual(conn.calls[1].params.clientData, {
      hdsCustomField: { 'note/txt': { version: 'v1', templateId: 'study', key: 'cmt', label: { en: 'cmt' } } }
    });
  });

  it('[APS6] is idempotent — tolerates item-already-exists', async () => {
    const conn = mockConn([
      { error: { id: 'item-already-exists' } },
      { error: { id: 'item-already-exists' } }
    ]);
    const r = await ensureAppStreamsTree(conn, {
      appId: 'foo',
      subStreams: [{ suffix: 'notes', name: 'Notes' }]
    });
    assert.equal(r.appStreamId, 'foo-app');
    assert.equal(r.subStreamIds.notes, 'foo-app-notes');
  });

  it('[APS7] throws on real errors (not item-already-exists)', async () => {
    const conn = mockConn([{ error: { id: 'permission-denied' } }]);
    await assert.rejects(
      () => ensureAppStreamsTree(conn, { appId: 'foo' }),
      /permission-denied/
    );
  });

  it('[APS8] rejects empty appId', async () => {
    const conn = mockConn([]);
    await assert.rejects(() => ensureAppStreamsTree(conn, { appId: '' }), /appId/);
    await assert.rejects(() => ensureAppStreamsTree(conn, {} as any), /appId/);
  });

  it('[APS9] rejects empty substream suffix', async () => {
    const conn = mockConn([]);
    await assert.rejects(
      () => ensureAppStreamsTree(conn, { appId: 'foo', subStreams: [{ suffix: '', name: 'x' }] }),
      /suffix/
    );
  });
});
