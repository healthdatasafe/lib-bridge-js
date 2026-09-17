import boiler from 'dev-boiler';
import type { Request, Response, NextFunction } from 'express';

let _logger: ReturnType<typeof boiler.getLogger> | null = null;
function expressErrorLogger () { return _logger || (_logger = boiler.getLogger('expressError')); }

export interface AppError extends Error {
  statusCode?: number;
  errorObject?: unknown;
  skipWebHookCall?: boolean;
  webhookParams?: Record<string, unknown>;
}

interface PartnerRequest extends Request {
  isPartner?: boolean;
}

interface LogResponse extends Response {
  log404?: boolean;
}

const REGEXP_URL = /^(https?:\/\/)?([\w-]+\.)+[\w-]+(\/[\w-]*)*$/;

/**
 * Middleware for express to manage errors
 */
function expressErrorHandler (err: AppError, req: Request, res: LogResponse, next: NextFunction): void {
  expressErrorLogger().error(err.message, err);
  if (res.headersSent) {
    next(err);
    return;
  }
  const statusCode = err.statusCode || 501;
  res.status(statusCode);
  if (statusCode === 404) {
    res.log404 = true; // tells the logger to keep this 404 in the logs.
  }
  const errorContent: { error: string; errorObject?: unknown } = { error: err.message };
  if (err.errorObject) errorContent.errorObject = err.errorObject;
  res.json(errorContent);
}

// ---------------- Errors ------------------ //

function unkownRessource (msg: string, obj?: unknown): never {
  const e: AppError = new Error('Ressource not found: ' + msg);
  e.statusCode = 404;
  if (obj) e.errorObject = obj;
  throw e;
}

function unauthorized (msg: string, obj?: unknown): never {
  const e: AppError = new Error('Unauthorized: ' + msg);
  e.statusCode = 401;
  if (obj) e.errorObject = obj;
  throw e;
}

function badRequest (msg: string, obj?: unknown): never {
  const e: AppError = new Error('Bad request: ' + msg);
  e.statusCode = 400;
  if (obj) e.errorObject = obj;
  throw e;
}

function internalError (msg: string, obj?: unknown): never {
  const e: AppError = new Error('Internal Error: ' + msg);
  e.statusCode = 501;
  if (obj) e.errorObject = obj;
  throw e;
}

function serviceError (msg: string, obj?: unknown): never {
  const e: AppError = new Error('Service Error: ' + msg);
  e.statusCode = 501;
  if (obj) e.errorObject = obj;
  throw e;
}

// ----------------- Asserts ---------------- //

/**
 * Throw an error if call is not from Partner backend
 */
function assertFromPartner (req: PartnerRequest): void {
  if (req.isPartner) return;
  const e: AppError = new Error('Unathorized');
  e.statusCode = 401;
  throw e;
}

/**
 * Throws an error a string is not a url
 */
function assertValidURL (url: string, extraMessage = ''): void {
  if (REGEXP_URL.test(url)) return;
  const e: AppError = new Error(`Invalid url "${url}" ${extraMessage}`);
  e.statusCode = 400;
  throw e;
}

/**
 * Throws an error if the partnerId is not in correct format
 */
function assertValidPartnerUserId (partnerUserId: string): void {
  if (partnerUserId != null && validateUserPartnerId(partnerUserId)) return;
  const e: AppError = new Error(`Invalid userPartnerId "${partnerUserId}"`);
  e.statusCode = 400;
  throw e;
}

/**
 * Throws an error if the email is not in correct format
 */
function assertValidEmail (email: string): void {
  if (email != null && validateEmail(email)) return;
  const e: AppError = new Error(`Invalid email "${email}"`);
  e.statusCode = 400;
  throw e;
}

// ----------------  Validators --------------//

/**
 * Helper to validate a userPartnerId
 */
function validateUserPartnerId (userPartnerId: string): boolean {
  return (userPartnerId != null && userPartnerId.length > 3);
}

/**
 * Helper to validate an email
 */
const validateEmail = (email: string): RegExpMatchArray | null => {
  return String(email)
    .toLowerCase()
    .match(
      /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|.(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/
    );
};

export {
  expressErrorHandler,
  assertValidEmail,
  assertValidPartnerUserId,
  assertFromPartner,
  assertValidURL,
  unkownRessource,
  unauthorized,
  badRequest,
  internalError,
  serviceError
};
