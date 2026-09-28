import bcrypt from 'bcryptjs';
import { createHash } from 'crypto';
import jwt from 'jsonwebtoken';
import { prisma } from '../../lib/prisma';
import { env } from '../../config/env';
import { conflict, forbidden, unauthorized, notFound } from '../../lib/errors';
import { randomToken } from '../../lib/ids';

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

export const hashPassword = (plain: string) => bcrypt.hash(plain, env.BCRYPT_COST);
export const verifyPassword = (plain: string, hash: string) => bcrypt.compare(plain, hash);

const hashRefreshToken = (token: string) => createHash('sha256').update(token).digest('hex');

export const ensureRoles = async () => {
  for (const name of ['CUSTOMER', 'ADMIN'] as const) {
    await prisma.role.upsert({ where: { name }, update: {}, create: { name } });
  }
};

export const register = async (input: {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  phone?: string;
}) => {
  const email = input.email.toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw conflict('EMAIL_TAKEN', 'An account with this email already exists');
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: await hashPassword(input.password),
      firstName: input.firstName,
      lastName: input.lastName,
      phone: input.phone,
      roles: { create: { role: { connectOrCreate: { where: { name: 'CUSTOMER' }, create: { name: 'CUSTOMER' } } } } },
    },
  });
  return user;
};

export const login = async (email: string, password: string) => {
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
    include: { roles: { include: { role: true } } },
  });
  if (!user) throw unauthorized('Invalid email or password');
  if (!user.isActive) throw forbidden('This account is disabled');
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw forbidden('Account temporarily locked due to failed attempts. Try again later.');
  }
  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    const failedLogins = user.failedLogins + 1;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLogins,
        lockedUntil: failedLogins >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null,
      },
    });
    throw unauthorized('Invalid email or password');
  }
  await prisma.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null } });
  return user;
};

export const issueTokens = async (userId: string, roles: string[]) => {
  const accessToken = signAccess(userId, roles);
  const refreshToken = randomToken(48);
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86400_000);
  await prisma.refreshToken.create({
    data: { userId, tokenHash: hashRefreshToken(refreshToken), expiresAt },
  });
  return { accessToken, refreshToken };
};

const signAccess = (userId: string, roles: string[]) =>
  jwt.sign({ sub: userId, roles }, env.JWT_ACCESS_SECRET, { expiresIn: env.ACCESS_TOKEN_TTL as jwt.SignOptions["expiresIn"] });

// Rotating refresh: validates the presented token, revokes it, issues a new pair.
// If a token is presented twice (reuse after theft), the whole chain is revoked.
export const rotateRefreshToken = async (presented: string) => {
  const tokenHash = hashRefreshToken(presented);
  const stored = await prisma.refreshToken.findUnique({ include: { user: { include: { roles: { include: { role: true } } } } }, where: { tokenHash } });
  if (!stored) throw unauthorized('Invalid refresh token');
  if (stored.revokedAt || stored.expiresAt < new Date()) {
    // Reuse detected: revoke all of the user's tokens.
    await prisma.refreshToken.updateMany({
      where: { userId: stored.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    throw unauthorized('Refresh token reuse detected. Please log in again.');
  }
  const { accessToken, refreshToken } = await issueTokens(
    stored.userId,
    stored.user.roles.map((r) => r.role.name),
  );
  await prisma.refreshToken.update({
    where: { id: stored.id },
    data: { revokedAt: new Date(), replacedBy: hashRefreshToken(refreshToken) },
  });
  return { accessToken, refreshToken, userId: stored.userId };
};

export const revokeRefreshToken = async (presented: string) => {
  await prisma.refreshToken.updateMany({
    where: { tokenHash: hashRefreshToken(presented), revokedAt: null },
    data: { revokedAt: new Date() },
  });
};

// --- Password reset (token architecture; email delivery is a later phase) ---

export const createPasswordResetToken = async (email: string) => {
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user) return null; // do not reveal account existence
  // Reuse refresh-token storage pattern: hashed single-use token, 1h TTL.
  const token = randomToken(32);
  await prisma.refreshToken.create({
    data: { userId: user.id, tokenHash: 'reset:' + hashRefreshToken(token), expiresAt: new Date(Date.now() + 3600_000) },
  });
  return token;
};

export const resetPassword = async (token: string, newPassword: string) => {
  const tokenHash = 'reset:' + hashRefreshToken(token);
  const stored = await prisma.refreshToken.findUnique({ where: { tokenHash } });
  if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
    throw notFound('Password reset link is invalid or expired');
  }
  await prisma.$transaction([
    prisma.user.update({
      where: { id: stored.userId },
      data: { passwordHash: await hashPassword(newPassword), failedLogins: 0, lockedUntil: null },
    }),
    prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } }),
    // Revoke every session after a password change.
    prisma.refreshToken.updateMany({ where: { userId: stored.userId, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);
};
