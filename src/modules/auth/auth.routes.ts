import { Router, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { env, isProd } from '../../config/env';
import { validate } from '../../middleware/validate';
import { apiLimiter } from '../../middleware/errorHandler';
import * as authService from './auth.service';

export const authRouter = Router();

const refreshTokenCookieName = 'kien_refresh';
const cookieOptions = {
  httpOnly: true,
  secure: isProd,
  sameSite: 'strict' as const,
  path: '/api/v1/auth',
  maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86400_000,
};

const credentialsSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8).max(128),
});

const readRefreshCookie = (res: Response, refreshToken: string) => {
  res.cookie(refreshTokenCookieName, refreshToken, cookieOptions);
};

authRouter.post(
  '/register',
  apiLimiter(60 * 60_000, 10),
  validate({
    body: credentialsSchema.extend({
      firstName: z.string().min(1).max(80),
      lastName: z.string().min(1).max(80),
      phone: z.string().regex(/^\+?[0-9]{10,15}$/).optional(),
    }),
  }),
  async (req, res) => {
    const user = await authService.register(req.body);
    const roles = await prisma.userRole
      .findMany({ where: { userId: user.id }, include: { role: true } })
      .then((urs) => urs.map((ur) => ur.role.name));
    const tokens = await authService.issueTokens(user.id, roles);
    readRefreshCookie(res, tokens.refreshToken);
    res.status(201).json({
      data: { accessToken: tokens.accessToken, user: publicUser(user, roles) },
    });
  },
);

authRouter.post(
  '/login',
  apiLimiter(10 * 60_000, 10),
  validate({ body: credentialsSchema }),
  async (req, res) => {
    const user = await authService.login(req.body.email, req.body.password);
    const roles = await prisma.userRole
      .findMany({ where: { userId: user.id }, include: { role: true } })
      .then((urs) => urs.map((ur) => ur.role.name));
    const tokens = await authService.issueTokens(user.id, roles);
    readRefreshCookie(res, tokens.refreshToken);
    res.json({ data: { accessToken: tokens.accessToken, user: publicUser(user, roles) } });
  },
);

authRouter.post('/refresh', async (req, res, next) => {
  try {
    const presented = (req.cookies?.[refreshTokenCookieName] as string) || '';
    const tokens = await authService.rotateRefreshToken(presented);
    readRefreshCookie(res, tokens.refreshToken);
    const roles = await prisma.userRole
      .findMany({ where: { userId: tokens.userId }, include: { role: true } })
      .then((urs) => urs.map((ur) => ur.role.name));
    res.json({ data: { accessToken: tokens.accessToken } });
  } catch (err) {
    res.clearCookie(refreshTokenCookieName, cookieOptions);
    next(err);
  }
});

authRouter.post('/logout', async (req, res) => {
  const presented = (req.cookies?.[refreshTokenCookieName] as string) || '';
  if (presented) await authService.revokeRefreshToken(presented);
  res.clearCookie(refreshTokenCookieName, cookieOptions);
  res.json({ data: { ok: true } });
});

authRouter.post(
  '/password/forgot',
  apiLimiter(60 * 60_000, 5),
  validate({ body: z.object({ email: z.string().email().max(254) }) }),
  async (req, res) => {
    const token = await authService.createPasswordResetToken(req.body.email);
    // Email delivery is a later phase. In non-production we surface the token
    // so the flow is testable; production must never include it.
    res.json({
      data: {
        ok: true,
        message: 'If an account exists, a reset link has been sent.',
        ...(token && !isProd ? { devResetToken: token } : {}),
      },
    });
  },
);

authRouter.post(
  '/password/reset',
  apiLimiter(60 * 60_000, 10),
  validate({ body: z.object({ token: z.string().min(32).max(128), password: z.string().min(8).max(128) }) }),
  async (req, res) => {
    await authService.resetPassword(req.body.token, req.body.password);
    res.json({ data: { ok: true } });
  },
);

export const publicUser = (
  user: { id: string; email: string; firstName: string; lastName: string; phone: string | null; emailVerifiedAt: Date | null },
  roles: string[],
) => ({
  id: user.id,
  email: user.email,
  firstName: user.firstName,
  lastName: user.lastName,
  phone: user.phone,
  emailVerified: !!user.emailVerifiedAt,
  roles,
});
