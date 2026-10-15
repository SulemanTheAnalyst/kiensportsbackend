import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';

/**
 * PRIVILEGED ADMIN ACCOUNT BOOTSTRAP / RECOVERY.
 *
 * This is an explicit, operator-run recovery tool - NOT part of application
 * startup or deployment. Nothing in the codebase invokes it automatically.
 *
 * It can create an administrator account or reset the password of an existing
 * one, and is therefore capable of changing who can administer the system.
 * Run it only after verifying the database target:
 *
 *   1. Check DATABASE_URL points at the intended database.
 *   2. Confirm deliberately:
 *        CONFIRM_ADMIN_BOOTSTRAP=YES \
 *        ADMIN_EMAIL=admin@kiensports.com \
 *        ADMIN_PASSWORD='<strong password>' \
 *        npm run db:admin
 *
 * Safety behaviour:
 * - Aborts BEFORE connecting to the database unless CONFIRM_ADMIN_BOOTSTRAP=YES.
 * - Prints the database host and name (never credentials or the full URL).
 * - Never logs the supplied password or its hash.
 * - Touches only the target admin account and the ADMIN role definition.
 *   Unrelated users and business records are never modified.
 *
 * Behaviour:
 * - Creates the admin user (with ADMIN role) if it does not exist.
 * - If it exists: resets the password hash (bcrypt), clears the failed-login
 *   lockout (failedLogins/lockedUntil), reactivates the account, and ensures
 *   the ADMIN role is attached.
 */

const CONFIRM_VAR = 'CONFIRM_ADMIN_BOOTSTRAP';
const CONFIRM_VALUE = 'YES';

/** Safe display of the database target: host + database name only. */
const describeDatabaseTarget = (url: string): string => {
  try {
    const parsed = new URL(url);
    const host = parsed.host;
    const dbName = parsed.pathname.replace(/^\//, '').split('?')[0] || '(unnamed)';
    return host + '/' + dbName;
  } catch {
    return '(unrecognised DATABASE_URL format)';
  }
};

const run = async () => {
  // --- Confirmation gate: checked before ANY database connection. ---
  if (process.env[CONFIRM_VAR] !== CONFIRM_VALUE) {
    throw new Error(
      'Aborted: ' + CONFIRM_VAR + ' is not set to "' + CONFIRM_VALUE + '". ' +
        'This script can reset an administrator password, so it must be run deliberately. ' +
        'Verify DATABASE_URL points at the intended database, then re-run with ' +
        CONFIRM_VAR + '=' + CONFIRM_VALUE + '.',
    );
  }

  const email = z.string().email().parse(process.env.ADMIN_EMAIL).toLowerCase();
  const password = z.string().min(10, 'ADMIN_PASSWORD must be at least 10 characters').parse(process.env.ADMIN_PASSWORD);
  const cost = Number(process.env.BCRYPT_COST ?? 12);
  const databaseUrl = z.string().min(1).parse(process.env.DATABASE_URL);

  // Safe target display - host and database name only, never credentials.
  console.log('Admin bootstrap target database: ' + describeDatabaseTarget(databaseUrl));
  console.log('Admin account: ' + email);

  // Connect only after the confirmation gate has passed.
  const prisma = new PrismaClient();
  try {
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
  } finally {
    await prisma.$disconnect();
  }
};

run().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
