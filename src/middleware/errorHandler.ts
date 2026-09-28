import { NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { ApiError } from '../lib/errors';
import { logger } from '../lib/logger';

export const apiLimiter = (windowMs: number, max: number) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, _res, next) => next(new ApiError(429, 'RATE_LIMITED', 'Too many requests, slow down')),
  });

export const notFoundHandler = (req: Request, _res: Response, next: NextFunction) => {
  next(new ApiError(404, 'NOT_FOUND', 'Route not found: ' + req.method + ' ' + req.path));
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const errorHandler = (err: unknown, req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ApiError) {
    res.status(err.statusCode).json({
      error: { code: err.code, message: err.message, details: err.details ?? null },
    });
    return;
  }
  // Unknown error: log details server-side, return a generic message.
  logger.error(
    { err: err instanceof Error ? { message: err.message, stack: err.stack } : err, path: req.path },
    'Unhandled error',
  );
  res.status(500).json({
    error: { code: 'INTERNAL', message: 'Something went wrong. Please try again later.', details: null },
  });
};
