import { NextFunction, Request, Response } from 'express';
import { z, ZodSchema } from 'zod';
import { badRequest } from '../lib/errors';

// Validate any part of the request against a Zod schema.
// Parsed (and coerced) data replaces the original on req.
export const validate =
  (schemas: { body?: ZodSchema; query?: ZodSchema; params?: ZodSchema }) =>
  (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (schemas.params) req.params = schemas.params.parse(req.params) as never;
      if (schemas.query) {
        const q = schemas.query.parse(req.query);
        Object.defineProperty(req, 'query', { value: q, writable: true, configurable: true });
      }
      if (schemas.body) req.body = schemas.body.parse(req.body);
      next();
    } catch (err) {
      if (err instanceof z.ZodError) {
        next(
          badRequest(
            'Request validation failed',
            err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          ),
        );
      } else next(err);
    }
  };
