import { NextFunction, Request, Response } from 'express';
import { logger } from '../lib/logger';

// Lightweight request-duration observability.
//
// Every API response is logged with method, path, status and duration in
// milliseconds. Anything at or above SLOW_MS is escalated to a warn so cold
// starts and performance regressions stand out in the Render log stream.
// Only the path is logged - no query strings, no headers, no bodies, no PII,
// no secrets.
export const SLOW_MS = 500;

export const requestTiming = (req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const entry = { method: req.method, path: req.path, status: res.statusCode, ms };
    if (ms >= SLOW_MS) logger.warn(entry, 'Slow request');
    else logger.info(entry, 'Request');
  });
  next();
};
