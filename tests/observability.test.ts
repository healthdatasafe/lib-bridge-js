import assert from 'assert';
import { EventEmitter } from 'events';
import type { Request, Response } from 'express';
import { observabilityTiming, type ObsHolder } from '../src/lib/observability.ts';

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
      [422, 'UPSTREAM_ERROR']
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
