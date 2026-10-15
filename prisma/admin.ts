import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';

/**
 * Secure local admin bootstrap / reset.
 *
 * Usage (password always supplied via env, never committed or logged):
 *   ADMIN_EMAIL=admin@kiensports.com ADMIN_PASSWORD='<strong password>' npm run db:admin
 *
 * Behaviour:
 * - Creates the admin user if it does not exist.
 * - If it exists, RESETS the password hash (bcrypt), clears the failed-login
 *   lockout and ensures the ADMIN role is attached.
 * - Never prints the password or the hash. Local development procedure only;
 *   production credentials are managed out-of-band.
 */

const prisma = new PrismaClient();

const run = async () => {
  const email = z.string().email().parse(process.env.ADMIN_EMAIL).toLowerCase();
  const password = z.string().min(10, 'ADMIN_PASSWORD must be at least 10 characters').parse(process.env.ADMIN_PASSWORD);
  const cost = Number(process.env.BCRYPT_COST ?? 12);

  const passwordHash = await bcrypt.hash(password, cost);

  await prisma.role.upsert({ where: { name: 'ADMIN' }, update: {}, create: { name: 'ADMIN' } });

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    const role = await prisma.role.findUniqueOrThrow({ where: { name: 'ADMIN' } });
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: existing.id, roleId: role.id } },
      update: {},
      create: { userId: existing.id, roleId: role.id },
    });
    await prisma.user.update({
      where: { email },
      data: { passwordHash, isActive: true, failedLogins: 0, lockedUntil: null },
    });
    console.log('Admin password reset, lockout cleared and ADMIN role ensured for: ' + email);
  } else {
    await prisma.user.create({
      data: {
        email,
        passwordHash,
        firstName: 'KIEN',
        lastName: 'Admin',
        emailVerifiedAt: new Date(),
        roles: { create: { role: { connect: { name: 'ADMIN' } } } },
      },
    });
    console.log('Admin user created with ADMIN role: ' + email);
  }
};

run()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
