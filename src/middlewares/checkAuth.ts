import boiler from 'dev-boiler';
import type { Request, Response, NextFunction } from 'express';

const { getConfig } = boiler;

interface PartnerRequest extends Request {
  isPartner?: boolean;
}

let partnerAuthToken: string | null = null;

async function init (): Promise<void> {
  const config = await getConfig();
  partnerAuthToken = config.get<string>('partnerAuthToken');
}

async function checkIfPartner (req: PartnerRequest, _res: Response, next: NextFunction): Promise<void> {
  if (req.headers.authorization === partnerAuthToken) {
    req.isPartner = true;
  }
  next();
}

export { init, checkIfPartner };
