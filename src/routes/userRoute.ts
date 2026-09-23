import Router from 'express-promise-router';
import type { Request, Response } from 'express';
import * as errors from '../errors/index.ts';
import * as onboard from '../methods/onboard.ts';
import * as user from '../methods/user.ts';

const router = Router();

/**
 * Onboarding
 * body:
 *  - returnURL
 *  - partnerUserId
 * result: @see https://pryv.github.io/reference/#authenticate-your-app
 */
router.post('/onboard/', async (req: Request, res: Response) => {
  errors.assertFromPartner(req as any);
  const partnerUserId = req.body.partnerUserId;
  errors.assertValidPartnerUserId(partnerUserId);
  const redirectURLs = req.body.redirectURLs;
  if (!redirectURLs) errors.badRequest('redirectURLs missing');
  for (const key of ['success', 'cancel']) {
    errors.assertValidURL(redirectURLs[key], 'redirectURLs.' + key);
  }
  const webhookClientData = req.body.clientData || {};
  for (const key of ['onboardingSecret', 'partnerUserId', 'status', 'error', 'errorObject', 'type', 'errorObjectJSON', 'pluginResultJSON', 'pluginResult']) {
    if (webhookClientData[key]) errors.badRequest(`clientData.${key} is not  is a reserved key`);
  }

  const onboardingProcess = await onboard.initiate(partnerUserId, redirectURLs, webhookClientData);
  res.json(onboardingProcess);
});

/**
 * Onboarding
 * returnURL of an onboarding process (from User's consent page)
 * result: @see https://pryv.github.io/reference/#authenticate-your-app
 */
router.get('/onboard/finalize/:partnerUserId', async (req: Request, res: Response) => {
  // partnerUserId
  const partnerUserId = req.params.partnerUserId!;
  errors.assertValidPartnerUserId(partnerUserId);
  const pollURL = req.query.prYvpoll as string;
  const redirectURL = await onboard.finalize(partnerUserId, pollURL);
  res.redirect(redirectURL);
});

/**
 * Get a userStatus
 */
router.get('/:partnerUserId/status', async (req: Request, res: Response) => {
  errors.assertFromPartner(req as any);
  const partnerUserId = req.params.partnerUserId!;
  errors.assertValidPartnerUserId(partnerUserId);
  const result = await user.status(partnerUserId);
  res.json(result);
});

/**
 * Change the status of a user
 * - active: true/false
 */
router.post('/:partnerUserId/status', async (req: Request, res: Response) => {
  errors.assertFromPartner(req as any);
  const partnerUserId = req.params.partnerUserId!;
  errors.assertValidPartnerUserId(partnerUserId);
  const active = req.body.active;
  if (active !== true && active !== false) errors.badRequest('active must be true or false');
  const result = await user.setStatus(partnerUserId, active);
  res.json(result);
});

/**
 * Get a list of all user's apiEndpoint
 *
 * Partner-only: the response carries every user's `credentials/pryv-api-endpoint`
 * event, and a Pryv apiEndpoint embeds its auth token. This route shipped without
 * the assertion its four siblings carry, leaving it readable by anyone who could
 * reach the bridge (it is mounted at `/user` for every framework bridge — see
 * `server.ts`). Fixed 2026-09-23.
 */
router.get('/list/apiEndPoints', async (req: Request, res: Response) => {
  errors.assertFromPartner(req as any);
  const users: unknown[] = [];
  function forEachEvent (event: unknown): void {
    users.push(event);
  }
  await user.getAllUsersApiEndpoints(forEachEvent);
  res.json({ users });
});

export default router;
