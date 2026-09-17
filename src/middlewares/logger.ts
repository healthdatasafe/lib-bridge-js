import boiler from 'dev-boiler';
import type { Request, Response, NextFunction } from 'express';

let _logger: ReturnType<typeof boiler.getLogger> | null = null;
function logger () { return _logger || (_logger = boiler.getLogger('server')); }

interface LogResponse extends Response {
  log404?: boolean;
}

function expressLogger (req: Request, res: LogResponse, next: NextFunction): void {
  if (res.headersSent) {
    doLog(req, res);
  } else {
    res.on('finish', function () {
      doLog(req, res);
    });
  }
  next();
}

function doLog (req: Request, res: LogResponse): void {
  if (res.statusCode === 404 && !res.log404) {
    // eventually log 404 elswhere
    return;
  }
  logger().info(`${req.method} ${req.url} ${res.statusCode}`);
}

export default expressLogger;
