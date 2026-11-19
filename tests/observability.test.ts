import assert from 'assert';
import { EventEmitter } from 'events';
import express from 'express';
import type { Request, Response } from 'express';
import { createObservability, type Window } from 'hds-observability-js';
import initBoiler from '../src/initBoiler.ts';
import {
  observabilityTiming, initBridgeObservability, allowList, bridgeTelemetry, setTelemetryHolderForTests,
  CMC_METHOD_IDS, CMC_ERROR_CODES, type ObsHolder
} from '../src/lib/observability.ts';

/**
 * Unit tests for the bridge telemetry middleware (plan 88). These exercise the
 * recording logic directly — no live pryv service — and pin the fence-critical
 * property: the method id is the route PATTERN, never a concrete path.
 */
describe('[OBS] observability middleware', () => {
  function fakeRes (statusCode: number): Response {
    const res = new EventEmitter() as unknown as Response;
    res.statusCode = statusCode;
    return res;
  }

  async function run (req: Partial<Request>, res: Response, holder: ObsHolder): Promise<void> {
    await new Promise<void>((resolve) => {
      observabilityTiming(holder)(req as Request, res, () => {
        (res as unknown as EventEmitter).emit('finish');
        resolve();
      });
    });
  }

  function stubHolder (calls: Array<[string, string]>, errs: string[] = []): ObsHolder {
    return {
      obs: {
        recordCall: (m, s, _d) => { calls.push([m, s]); },
        recordError: (c) => { errs.push(c); },
        flush: async () => {},
        stop: async () => {}
      }
    };
  }

  it('records the route PATTERN (a param stays `:id`, never a concrete value) + status class', async () => {
    const calls: Array<[string, string]> = [];
    await run(
      { method: 'GET', baseUrl: '/user', route: { path: '/:partnerUserId/status' } as Request['route'] },
      fakeRes(200), stubHolder(calls)
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.[0], 'GET /user/:partnerUserId/status');
    assert.equal(calls[0]?.[1], '2xx');
  });

  it('maps a >=400 response to a status class AND a framework error code', async () => {
    const calls: Array<[string, string]> = []; const errs: string[] = [];
    await run(
      { method: 'POST', baseUrl: '/user', route: { path: '/onboard/' } as Request['route'] },
      fakeRes(401), stubHolder(calls, errs)
    );
    assert.equal(calls[0]?.[1], '4xx');
    assert.equal(errs[0], 'UNAUTHORIZED');
  });

  it('maps 429 to RATE_LIMITED, 502/503/504 to UPSTREAM_ERROR, other 5xx to INTERNAL_ERROR (B-2026-11-02-7)', async () => {
    const expected: Array<[number, string]> = [
      [429, 'RATE_LIMITED'],
      [502, 'UPSTREAM_ERROR'], [503, 'UPSTREAM_ERROR'], [504, 'UPSTREAM_ERROR'],
      [500, 'INTERNAL_ERROR'], [501, 'INTERNAL_ERROR'], [505, 'INTERNAL_ERROR'],
      [400, 'BAD_REQUEST'], [403, 'FORBIDDEN'], [404, 'NOT_FOUND'], [409, 'CONFLICT'],
      [405, 'BAD_REQUEST'], [413, 'BAD_REQUEST'], [422, 'BAD_REQUEST']
    ];
    for (const [status, code] of expected) {
      const calls: Array<[string, string]> = []; const errs: string[] = [];
      await run(
        { method: 'GET', baseUrl: '', route: { path: '/status' } as Request['route'] },
        fakeRes(status), stubHolder(calls, errs)
      );
      assert.deepEqual(errs, [code], `status ${status}`);
    }
  });

  it('keeps the mount prefix on an ERRORED mounted request (baseUrl already unwound)', async () => {
    const calls: Array<[string, string]> = [];
    // Express restores req.baseUrl to '' while unwinding a router to reach the app-level
    // error handler, and `finish` fires after that — so a failed request on a mounted
    // router arrives here with an empty baseUrl. Naming it from baseUrl alone produced
    // 'GET /authReturn/', which matched no collected method and was dropped as
    // unknown_method: telemetry lost precisely the requests that failed. Observed on
    // prod 2026-08-28.
    await run(
      { method: 'GET', baseUrl: '', originalUrl: '/mira/authReturn?code=x', route: { path: '/authReturn/' } } as Partial<Request>,
      fakeRes(500),
      stubHolder(calls)
    );
    assert.deepEqual(calls, [['GET /mira/authReturn/', '5xx']]);
  });

  it('keeps using baseUrl when it survived (successful mounted request)', async () => {
    const calls: Array<[string, string]> = [];
    await run(
      { method: 'GET', baseUrl: '/mira', originalUrl: '/mira/health', route: { path: '/health' } } as Partial<Request>,
      fakeRes(200),
      stubHolder(calls)
    );
    assert.deepEqual(calls, [['GET /mira/health', '2xx']]);
  });

  it('recovers a multi-segment mount and keeps param patterns intact', async () => {
    const calls: Array<[string, string]> = [];
    await run(
      { method: 'GET', baseUrl: '', originalUrl: '/a/b/user/42/status', route: { path: '/user/:id/status' } } as Partial<Request>,
      fakeRes(500),
      stubHolder(calls)
    );
    assert.deepEqual(calls, [['GET /a/b/user/:id/status', '5xx']]);
  });

  it('leaves an app-level route unprefixed', async () => {
    const calls: Array<[string, string]> = [];
    await run(
      { method: 'GET', baseUrl: '', originalUrl: '/status', route: { path: '/status' } } as Partial<Request>,
      fakeRes(200),
      stubHolder(calls)
    );
    assert.deepEqual(calls, [['GET /status', '2xx']]);
  });

  it('skips an unmatched request (no req.route) — nothing to name as a method', async () => {
    const calls: Array<[string, string]> = [];
    await run({ method: 'GET', baseUrl: '', route: undefined }, fakeRes(404), stubHolder(calls));
    assert.equal(calls.length, 0);
  });

  it('is an inert no-op before the emitter is built (holder.obs === null)', async () => {
    await run({ method: 'GET', baseUrl: '', route: { path: '/status' } as Request['route'] }, fakeRes(200), { obs: null });
    // reaching here without throwing is the assertion
    assert.ok(true);
  });
});

describe('[OBSC] closed sets: CMC ids, plugin extras, bridgeTelemetry', () => {
  afterEach(() => setTelemetryHolderForTests(null));

  function emitter (methods: string[], errorCodes: string[]) {
    const windows: Window[] = [];
    const refused: Array<[string, string]> = [];
    const obs = createObservability<string, string>({
      service: { name: 'test', version: '0', instance: 'i' },
      methods,
      errorCodes,
      exporter: async (w) => { windows.push(w); },
      minCellCount: 1,
      setInterval: (() => ({ unref () {} })) as unknown as typeof setInterval,
      onRefused: (reason, value) => { refused.push([reason, value]); }
    });
    return { obs, windows, refused };
  }

  it('[OBSD] the allow-list is routes + every CMC id + plugin extras, framework codes kept', () => {
    const { methods, errorCodes } = allowList(['GET /status'], { methods: ['mira:sync'], errorCodes: ['mira_rate_limited'] });
    assert.deepEqual(methods, ['GET /status', ...CMC_METHOD_IDS, 'mira:sync']);
    for (const c of ['UNAUTHORIZED', 'INTERNAL_ERROR', ...CMC_ERROR_CODES, 'mira_rate_limited']) assert.ok(errorCodes.includes(c), c);
    assert.equal(CMC_METHOD_IDS.length, 6);
    assert.equal(CMC_ERROR_CODES.length, 10);
    assert.deepEqual(allowList(['GET /status']).methods, ['GET /status', ...CMC_METHOD_IDS], 'no extras');
  });

  it('[OBSE] bridgeTelemetry drops silently before the emitter is built', () => {
    bridgeTelemetry.recordCall('cmc:accept', '2xx', 1);
    bridgeTelemetry.recordError('cmc_accept_host');
    setTelemetryHolderForTests({ obs: null });
    bridgeTelemetry.recordCall('cmc:accept', '2xx', 1);
    assert.ok(true);
  });

  it('[OBSF] bridgeTelemetry forwards declared ids; an undeclared id is refused, never sent', async () => {
    const { methods, errorCodes } = allowList(['GET /status'], { methods: ['mira:sync'] });
    const { obs, windows, refused } = emitter(methods, errorCodes);
    setTelemetryHolderForTests({ obs });
    bridgeTelemetry.recordCall('cmc:accept', '2xx', 12);
    bridgeTelemetry.recordCall('mira:sync', '5xx', 3);
    bridgeTelemetry.recordError('cmc_accept_wrong_person');
    bridgeTelemetry.recordCall('cmc:accept:alice', '2xx', 1);
    bridgeTelemetry.recordError('cmc_not_declared');
    await obs.flush();
    const w = windows[0]!;
    assert.deepEqual(w.calls.map(c => [c.method, c.statusClass]).sort(), [['cmc:accept', '2xx'], ['mira:sync', '5xx']]);
    assert.deepEqual(w.errors.map(e => e.code), ['cmc_accept_wrong_person']);
    assert.deepEqual(refused, [['unknown_method', 'cmc:accept:alice'], ['unknown_error_code', 'cmc_not_declared']]);
    await obs.stop();
  });

  it('[OBSG] initBridgeObservability passes the extras and wires bridgeTelemetry to the holder', async () => {
    initBoiler(`bridge-obs:${process.pid}`);
    const prev = process.env.HDS_OTEL_ENDPOINT;
    process.env.HDS_OTEL_ENDPOINT = 'http://127.0.0.1:9';
    const app = express();
    app.get('/status', (_req, res) => { res.end(); });
    const holder: ObsHolder = { obs: null };
    try {
      const handle = await initBridgeObservability(app, { name: 'x', version: '1' }, holder, { methods: ['mira:sync'] });
      assert.ok(handle != null && holder.obs != null);
      const built = holder.obs;
      const seen: string[] = [];
      holder.obs = { ...built, recordCall: (m) => { seen.push(m); } };
      bridgeTelemetry.recordCall('mira:sync', '2xx', 1);
      assert.deepEqual(seen, ['mira:sync']);
      holder.obs = built;
      await handle.stop();
      assert.equal(holder.obs, null);
    } finally {
      if (prev == null) delete process.env.HDS_OTEL_ENDPOINT; else process.env.HDS_OTEL_ENDPOINT = prev;
    }
  });
});
