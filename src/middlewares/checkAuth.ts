import boiler from 'dev-boiler';
import type { Request, Response, NextFunction } from 'express';

const { getConfig, getLogger } = boiler;

interface PartnerRequest extends Request {
  isPartner?: boolean;
}

let partnerAuthToken: string | null = null;

async function init (): Promise<void> {
  const config = await getConfig();
  const token = config.get<string>('partnerAuthToken');
  partnerAuthToken = (typeof token === 'string' && token.length > 0) ? token : null;
  if (partnerAuthToken === null) {
    // Loud, because the consequence is invisible at runtime: with no token there is
    // no way to authenticate as the partner, so every partner-only route answers 401
    // for everyone. A bridge that actually uses those routes is broken until this is
    // configured — and that is deliberately the safe direction (see below).
    getLogger('checkAuth').error(
      'partnerAuthToken is NOT configured — every partner-only route will reject all callers. ' +
      'Set `partnerAuthToken` in this bridge\'s config if it serves partner requests.'
    );
  }
}

/**
 * Marks a request as coming from the partner. Enforcement is each route's own job
 * via `errors.assertFromPartner`; this only sets the flag.
 *
 * SECURITY — this must fail CLOSED. The original implementation was a bare
 * `req.headers.authorization === partnerAuthToken`, which authenticated the wrong
 * caller whenever `partnerAuthToken` was unset: an unconfigured token is `undefined`
 * and an unauthenticated request's `authorization` header is also `undefined`, so
 * `undefined === undefined` marked every ANONYMOUS caller as the partner. Sending no
 * credentials succeeded while sending wrong ones failed — inverted auth.
 *
 * That was live on the deployed bridges (neither had `partnerAuthToken` configured),
 * confirmed 2026-09-23 against prod: no `Authorization` header returned 200, a bogus
 * one returned 401. It exposed every partner route, including `POST /user/:id/status`
 * (activate/deactivate any user) and `GET /user/list/apiEndPoints` (every user's Pryv
 * apiEndpoint, auth token embedded).
 *
 * Both sides are now required to be non-empty strings before a match can occur, so an
 * absent token can never authenticate anyone.
 */
async function checkIfPartner (req: PartnerRequest, _res: Response, next: NextFunction): Promise<void> {
  if (matchesPartnerToken(req.headers.authorization, partnerAuthToken)) {
    req.isPartner = true;
  }
  next();
}

/**
 * The credential comparison, extracted as a pure function so the fail-open case can be
 * tested with the exact production inputs. Reproducing it through `init()` is not
 * possible in-repo: `config/test-config.yml` defines `partnerAuthToken`, so a test that
 * goes through config can never reach the `undefined` token state that caused the bug.
 *
 * Both sides must be non-empty strings. In particular `matchesPartnerToken(undefined,
 * undefined)` — an anonymous request against an unconfigured bridge — is `false`.
 */
function matchesPartnerToken (header: unknown, token: unknown): boolean {
  if (typeof token !== 'string' || token.length === 0) return false;
  if (typeof header !== 'string' || header.length === 0) return false;
  return header === token;
}

export { init, checkIfPartner, matchesPartnerToken };
