import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import type { Server } from 'node:http';
import boiler from 'dev-boiler';
import { listenLocal } from './helpers/localServer.ts';
import initBoiler from '../src/initBoiler.ts';
import { expressErrorHandler, badRequest, unauthorized, internalError } from '../src/errors/index.ts';

/**
 * B-2026-10-14-17: a client error (4xx) is logged at warn without a stack; a server error
 * (5xx) stays at error with the full error. `getLogger` returns a new instance per call, so
 * the spy sits on the shared Logger prototype and keeps only the expressError logger's calls.
 */
describe('[ERLX] expressErrorHandler log level', function () {
  type Call = { level: string; message: unknown; meta: unknown };
  const calls: Call[] = [];
  let proto: any;
  let original: { warn: any; error: any };
  let server: Server;

  before(async function () {
    initBoiler(`bridge-erltest:${process.pid}`);
    proto = Object.getPrototypeOf(boiler.getLogger('erl-probe'));
    original = { warn: proto.warn, error: proto.error };
    for (const level of ['warn', 'error'] as const) {
      proto[level] = function (this: any, message: unknown, meta: unknown) {
        if (this._name().endsWith(':expressError')) calls.push({ level, message, meta });
        return original[level].call(this, message, meta);
      };
    }
    const app = express();
    app.get('/bad', () => badRequest('nope', { field: 'x' }));
    app.get('/unauth', () => unauthorized('who'));
    app.get('/internal', () => internalError('boom'));
    app.get('/plain', () => { throw new Error('no status'); });
    app.use(expressErrorHandler);
    server = await listenLocal(app);
  });

  after(function () {
    if (proto) Object.assign(proto, original);
  });

  beforeEach(() => { calls.length = 0; });

  it('[ERLA] a 4xx is logged once at warn, with status and errorObject, without the stack', async () => {
    await request(server).get('/bad');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.level, 'warn');
    assert.equal(calls[0]!.message, 'Bad request: nope');
    assert.deepEqual(calls[0]!.meta, { statusCode: 400, errorObject: { field: 'x' } });
    await request(server).get('/unauth');
    assert.equal(calls[1]!.level, 'warn');
  });

  it('[ERLB] a 5xx, and an error without a status, stay at error with the error itself', async () => {
    await request(server).get('/internal');
    await request(server).get('/plain');
    assert.deepEqual(calls.map(c => c.level), ['error', 'error']);
    assert.ok(calls.every(c => c.meta instanceof Error));
  });
});
