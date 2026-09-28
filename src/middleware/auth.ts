import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { forbidden, unauthorized } from '../lib/errors';

export interface AccessPayload {
  sub: string; // user id
  roles: string[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AccessPayload;
    }
  }
}

export const signAccessToken = (payload: AccessPayload): string =>
  jwt.sign(payload, env.JWT_ACCESS_SECRET, { expiresIn: env.ACCESS_TOKEN_TTL });

export const requireAuth = (req: Request, _res: Response, next: NextFunction) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return next(unauthorized());
  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessPayload;
    if (typeof payload.sub !== 'string' || !Array.isArray(payload.roles)) {
      return next(unauthorized());
    }
    req.user = payload;
    next();
  } catch {
    next(unauthorized('Invalid or expired token'));
  }
};

export const requireRole = (role: string) => (req: Request, _res: Response, next: NextFunction) => {
  if (!req.user) return next(unauthorized());
  if (!req.user.roles.includes(role)) return next(forbidden());
  next();
};

// Attach the authenticated user's full record if a valid token is present,
// but never reject the request when absent (used by cart merge).
export const optionalAuth = async (req: Request, _res: Response, next: NextFunction) => {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    try {
      const payload = jwt.verify(header.slice(7), env.JWT_ACCESS_SECRET) as AccessPayload;
      const user = await prisma.user.findUnique({ where: { id: payload.sub } });
      if (user?.isActive) req.user = payload;
    } catch {
      /* ignore - guest continues */
    }
  }
  next();
};
