import boiler from 'dev-boiler';
import os from 'os';
import type { Application, Request, Response, NextFunction, RequestHandler } from 'express';
import {
  createObservability,
  otlpExporter,
  type Observability,
  type StatusClass
} from 'hds-observability-js';

/**
 * Plan 88 — aggregate, allow-list telemetry for bridges.
 *
 * Replaces the New Relic APM agent (removed from `start.ts` and each bridge's
 * Procfile) with `hds-observability-js`: per route-pattern call counts and a
 * duration histogram, exported over OTLP to the host collector. No vendor SDK
 * runs in the process, and nothing free-text reaches the wire — method ids are
 * route PATTERNS (`req.route.path`, e.g. `/user/:partnerUserId/status`), never
 * concrete paths, and an unmatched request is dropped and counted, never sent.
 *
 * Enabled only when an endpoint is configured (`HDS_OTEL_ENDPOINT` env or
 * `observability:endpoint` config) — a non-monitored/dev deploy stays a no-op,
 * the same posture the optional New Relic agent had.
 */

/** Closed set of framework-level error codes, derived from HTTP status. */
const FRAMEWORK_ERROR_CODES = [
  'UNAUTHORIZED', 'FORBIDDEN', 'BAD_REQUEST', 'NOT_FOUND',
  'CONFLICT', 'UPSTREAM_ERROR', 'INTERNAL_ERROR'
] as const;
type FrameworkErrorCode = (typeof FRAMEWORK_ERROR_CODES)[number];

/** Filled after routes are registered; the timing middleware reads it live. */
export interface ObsHolder {
  obs: Observability<string, FrameworkErrorCode> | null;
}

const { getConfig, getLogger } = boiler;

function statusClassOf (code: number): StatusClass {
  const c = Math.floor(code / 100);
  return (c >= 2 && c <= 5) ? (`${c}xx` as StatusClass) : 'error';
}

function errorCodeOf (code: number): FrameworkErrorCode {
  switch (code) {
    case 401: return 'UNAUTHORIZED';
    case 403: return 'FORBIDDEN';
    case 400: return 'BAD_REQUEST';
    case 404: return 'NOT_FOUND';
    case 409: return 'CONFLICT';
    default: return code >= 500 ? 'INTERNAL_ERROR' : 'UPSTREAM_ERROR';
  }
}

/**
 * Segment count of a path, ignoring empty segments so a trailing slash does not
 * change the count (`/authReturn/` and `/authReturn` are both one segment).
 */
function segmentCount (p: string): number {
  return p.split('/').filter(s => s.length > 0).length;
}

/**
 * The mount prefix for this request, e.g. `/mira`.
 *
 * `req.baseUrl` is the direct answer and is correct for a request that completed
 * normally — but NOT for one that errored. When a handler calls `next(err)`, Express
 * unwinds the router to reach the app-level error handler and restores `req.baseUrl` to
 * `''` on the way out; `res.on('finish')` fires after that. So an errored request on a
 * mounted router used to be named `GET /authReturn/` instead of `GET /mira/authReturn/`,
 * which matches nothing in the collected method list and was refused as `unknown_method`.
 *
 * The consequence was the worst possible one for observability: the requests that FAILED
 * were exactly the ones silently dropped, so `hds.calls` could never show an error rate
 * for any mounted route. Observed on prod 2026-08-28.
 *
 * Recovery: `req.originalUrl` is never rewritten, so when `baseUrl` is empty but the
 * original path has more segments than the route pattern, the extra leading segments are
 * the mount prefix. Counting segments (rather than string-matching) keeps this correct for
 * patterns containing params, whose concrete values differ from the pattern text.
 */
function mountPrefix (req: Request, routePath: string): string {
  if (req.baseUrl != null && req.baseUrl !== '') return req.baseUrl;
  const original = (req.originalUrl ?? '').split('?')[0] ?? '';
  const originalSegs = original.split('/').filter(s => s.length > 0);
  const extra = originalSegs.length - segmentCount(routePath);
  if (extra <= 0) return '';
  return '/' + originalSegs.slice(0, extra).join('/');
}

/**
 * Timing middleware. Add it EARLY (before routes) so it spans the whole
 * request; it records on `finish`, by which point `req.route` is resolved. It
 * closes over a holder so it can be installed before the emitter exists.
 */
export function observabilityTiming (holder: ObsHolder): RequestHandler {
  return function (req: Request, res: Response, next: NextFunction): void {
    const start = performance.now();
    res.on('finish', () => {
      const obs = holder.obs;
      if (obs == null) return;
      try {
        const route = req.route as { path?: string } | undefined;
        if (route?.path == null) return; // unmatched path: not a known method
        const method = `${req.method} ${mountPrefix(req, route.path)}${route.path}`;
        obs.recordCall(method, statusClassOf(res.statusCode), performance.now() - start);
        if (res.statusCode >= 400) obs.recordError(errorCodeOf(res.statusCode));
      } catch { /* telemetry must never break a response */ }
    });
    next();
  };
}

interface RouteLayer {
  route?: { path: string; methods: Record<string, boolean> };
  name?: string;
  handle?: { stack?: RouteLayer[] };
  regexp?: RegExp & { fast_slash?: boolean };
}

/** The mount path of a sub-router layer, e.g. `/user`. Static mounts only. */
function mountPath (layer: RouteLayer): string {
  const re = layer.regexp;
  if (re == null || re.fast_slash === true) return '';
  const seg = /^\^\\\/(.+?)\\\/\?/.exec(re.source)?.[1];
  return seg != null ? '/' + seg.replace(/\\\//g, '/') : '';
}

/** Walk the Express router tree into the closed set of `METHOD /route/pattern`. */
function collectMethods (app: Application): string[] {
  const out = new Set<string>();
  const walk = (stack: RouteLayer[], prefix: string): void => {
    for (const layer of stack) {
      if (layer.route != null) {
        const p = prefix + layer.route.path;
        for (const [m, on] of Object.entries(layer.route.methods)) {
          if (on && m !== '_all') out.add(`${m.toUpperCase()} ${p}`);
        }
      } else if (layer.name === 'router' && layer.handle?.stack != null) {
        walk(layer.handle.stack, prefix + mountPath(layer));
      }
    }
  };
  const root = (app as unknown as { _router?: { stack?: RouteLayer[] } })._router;
  if (root?.stack != null) walk(root.stack, '');
  return [...out];
}

function metricsUrl (base: string): string {
  return base.endsWith('/v1/metrics') ? base : base.replace(/\/+$/, '') + '/v1/metrics';
}

function sanitize (v: string): string {
  const s = v.replace(/[^A-Za-z0-9._:-]/g, '-').replace(/^[^A-Za-z0-9]/, 'x').slice(0, 64);
  return s.length > 0 ? s : 'unknown';
}

/**
 * Build the emitter from the app's registered routes and fill the holder.
 * Call AFTER all routes (and plugin routes) are mounted. Returns a handle whose
 * `stop()` flushes and clears the timer; returns null when disabled.
 */
export async function initBridgeObservability (
  app: Application,
  pkg: { name?: string; version?: string },
  holder: ObsHolder
): Promise<{ stop: () => Promise<void> } | null> {
  const logger = getLogger('observability');
  const config = await getConfig();

  const endpoint = process.env.HDS_OTEL_ENDPOINT ?? config.get<string>('observability:endpoint');
  if (endpoint == null || endpoint === '') {
    logger.info('observability disabled — no HDS_OTEL_ENDPOINT / observability:endpoint configured');
    return null;
  }

  const env = process.env.HDS_ENV ?? config.get<string>('observability:env') ?? 'dev';
  const serviceName = process.env.HDS_OTEL_SERVICE_NAME ??
    config.get<string>('observability:serviceName') ??
    `hds-${env}-${pkg.name ?? 'bridge'}`;

  const methods = collectMethods(app);
  if (methods.length === 0) {
    logger.warn('observability: no routes collected — not enabling (an empty allow-list refuses every call)');
    return null;
  }

  const obs = createObservability({
    service: {
      name: sanitize(serviceName),
      version: sanitize(String(pkg.version ?? '0.0.0')),
      instance: sanitize(os.hostname() || String(process.pid))
    },
    methods,
    errorCodes: FRAMEWORK_ERROR_CODES,
    exporter: otlpExporter({ endpoint: metricsUrl(endpoint) }),
    onRefused: (reason, value) => logger.warn(`observability drop [${reason}]: ${value}`)
  });

  holder.obs = obs;
  logger.info(`observability enabled: service=${sanitize(serviceName)} endpoint=${metricsUrl(endpoint)} methods=${methods.length}`);
  return { stop: async () => { holder.obs = null; await obs.stop(); } };
}
