import assert from 'node:assert/strict';
import { errorRedirectURL } from '../src/methods/onboard.ts';

/**
 * Bridges that onboard through CMC ship `partnerURLs.defaultRedirectOnError: OVERRIDE_ME`,
 * and a failed `/user/onboard/finalize` redirected to `…/finalize/OVERRIDE_ME?message=…`,
 * a dead page (B-2026-09-29-6). Without an absolute http(s) URL the bridge answers 400.
 */
describe('[OERX] onboard error redirect', function () {
  it('[OER1] redirects to a configured absolute URL with the message', () => {
    assert.equal(
      errorRedirectURL('https://error.domain', 'No matching pending request'),
      'https://error.domain?message=No%20matching%20pending%20request'
    );
  });

  for (const base of ['OVERRIDE_ME', '', null, undefined, '/relative/path', 'error.domain', 'javascript:alert(1)']) {
    it(`[OER2] answers 400 instead of redirecting when the target is ${JSON.stringify(base)}`, () => {
      assert.throws(
        () => errorRedirectURL(base, 'No matching pending request'),
        (e: any) => e.statusCode === 400 && e.message === 'Bad request: No matching pending request'
      );
    });
  }
});
