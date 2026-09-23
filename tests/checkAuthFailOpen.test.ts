import assert from 'node:assert/strict';
import { matchesPartnerToken } from '../src/middlewares/checkAuth.ts';

/**
 * Regression for an INVERTED-AUTH vulnerability in `checkIfPartner`.
 *
 * The original middleware was a bare `req.headers.authorization === partnerAuthToken`.
 * When `partnerAuthToken` was not configured, `config.get()` returned `undefined`, and
 * an unauthenticated request's `authorization` header is also `undefined` — so
 * `undefined === undefined` marked every ANONYMOUS caller as the partner. Sending no
 * credentials authenticated you; sending wrong ones did not.
 *
 * It was live on the deployed bridges, neither of which had `partnerAuthToken`
 * configured, exposing every partner-only route — including `POST /user/:id/status`
 * (activate/deactivate any user) and `GET /user/list/apiEndPoints` (every user's Pryv
 * apiEndpoint, auth token embedded). Confirmed against prod on 2026-09-23: no
 * `Authorization` header returned 200, a bogus one returned 401.
 *
 * These assert the pure comparison rather than driving the middleware through `init()`,
 * deliberately: `config/test-config.yml` defines `partnerAuthToken`, so no config-driven
 * test can reach the `undefined` state that caused this. The first case below is the
 * vulnerability itself and fails against the original one-line comparison.
 */
describe('[CKAX] partner token comparison fails closed', function () {
  it('[CKAN] THE BUG: an anonymous request against an unconfigured bridge is not the partner', () => {
    assert.equal(matchesPartnerToken(undefined, undefined), false,
      'no header + no configured token must NOT authenticate — this is the live 2026-09-23 exposure');
  });

  it('[CKAU] an unconfigured token rejects every caller', () => {
    assert.equal(matchesPartnerToken('anything', undefined), false);
    assert.equal(matchesPartnerToken(undefined, null), false);
    assert.equal(matchesPartnerToken('', undefined), false);
  });

  it('[CKAE] an empty configured token never matches', () => {
    assert.equal(matchesPartnerToken('', ''), false, 'empty === empty must not authenticate');
    assert.equal(matchesPartnerToken(undefined, ''), false);
  });

  it('[CKAB] a wrong token is rejected when one IS configured', () => {
    assert.equal(matchesPartnerToken('bogus', 'the-real-token'), false);
    assert.equal(matchesPartnerToken(undefined, 'the-real-token'), false);
    assert.equal(matchesPartnerToken('', 'the-real-token'), false);
  });

  it('[CKAV] the correct token still authenticates', () => {
    assert.equal(matchesPartnerToken('the-real-token', 'the-real-token'), true);
  });

  it('[CKAT] non-string headers cannot match', () => {
    assert.equal(matchesPartnerToken(['the-real-token'], 'the-real-token'), false);
    assert.equal(matchesPartnerToken({}, {}), false);
  });
});
