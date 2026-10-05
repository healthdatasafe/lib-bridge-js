import cors from 'cors';
import type { RequestHandler } from 'express';
import { normalizeAllowedOrigins } from '../lib/connectorStatus.ts';

/**
 * How a bridge answers cross-origin browser requests, from `server:corsOrigins`.
 *
 * - unset (`null`, absent, empty string): every origin, as before this key existed. Kept as
 *   the default so a bridge deployed on a new lib-bridge-js does not start refusing the HDS
 *   apps before its environment lists them. `open-default` is logged as a warning.
 * - `'*'` (or `['*']`): every origin, chosen explicitly.
 * - a list (array, JSON array string or comma-separated string): only those exact https
 *   origins. Other origins get no `Access-Control-Allow-Origin`, so the browser blocks the
 *   response. An unparseable list allows no origin at all (fail closed).
 *
 * CORS only governs browsers: server-to-server partner calls send no `Origin` and are
 * unaffected either way.
 */
export type CorsMode = 'open-default' | 'open' | 'allow-list';

export function corsSettings (value: unknown): { mode: CorsMode, origins: string[] } {
  if (value == null || (typeof value === 'string' && value.trim() === '')) {
    return { mode: 'open-default', origins: [] };
  }
  if (value === '*' || (Array.isArray(value) && value.length === 1 && value[0] === '*')) {
    return { mode: 'open', origins: [] };
  }
  return { mode: 'allow-list', origins: normalizeAllowedOrigins(value) };
}

interface MinimalLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

export function corsMiddleware (value: unknown, logger: MinimalLogger): RequestHandler {
  const { mode, origins } = corsSettings(value);
  if (mode === 'open-default') {
    logger.warn('CORS is open to every origin: set `server:corsOrigins` (env `server__corsOrigins`, a JSON array of the HDS app origins) to restrict it.');
    return cors();
  }
  if (mode === 'open') {
    logger.info('CORS is open to every origin (`server:corsOrigins` = "*").');
    return cors();
  }
  if (origins.length === 0) {
    logger.warn('`server:corsOrigins` holds no valid https origin: every cross-origin browser request will be refused.');
  } else {
    logger.info(`CORS allowed origins: ${origins.join(', ')}`);
  }
  return cors({ origin: origins });
}
