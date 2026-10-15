import { PrismaClient } from '@prisma/client';

/**
 * LOCAL DEVELOPMENT DATABASE CLEANUP.
 *
 * Removes all mock/test business data while preserving:
 * - the existing ADMIN account (password hash untouched),
 * - the ADMIN + CUSTOMER role definitions,
 * - the schema and migration history (this script never runs migrations).
 *
 * Safety guards:
 * - Refuses to run when NODE_ENV=production.
 * - Aborts if no admin account exists, or if multiple exist (so the operator
 *   can choose explicitly).
 * - Prints before/after counts. Never prints passwords or hashes.
 * - Runs inside a single Prisma transaction: on any error, nothing is deleted.
 *
 * Usage:  npm run db:clean        (host with local DATABASE_URL, or via tsx)
 */

const prisma = new PrismaClient();

const CLEAN_ORDER = [
  'auditLog',
  'contactMessage',
  'newsletterSubscriber',
  'refund',
  'returnRequest',
  'shipment',
  'payment',
  'orderStatusEvent',
  'orderItem',
  'order',
  'review',
  'wishlistItem',
  'cartItem',
  'cart',
  'inventoryMovement',
  'inventory',
  'productVariant',
  'productFeature',
  'productImage',
  'product',
  'collection',
  'category',
] as const;

const run = async () => {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to clean: NODE_ENV=production. This tool is for the local development database only.');
  }

  // ---- Identify the administrator(s) to preserve ----
  const adminRole = await prisma.role.findUnique({ where: { name: 'ADMIN' } });
  if (!adminRole) {
    throw new Error('No ADMIN role defined. Run migrations first (npm run db:migrate); aborting without deleting anything.');
  }
  const adminUsers = await prisma.user.findMany({
    where: { roles: { some: { roleId: adminRole.id } } },
    select: { id: true, email: true, passwordHash: true, isActive: true, roles: { include: { role: true } } },
  });
  if (adminUsers.length === 0) {
    throw new Error('No administrator account found. Nothing was deleted. Create one with: ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run db:admin');
  }
  if (adminUsers.length > 1) {
    throw new Error(
      'Multiple administrator accounts found: ' +
        adminUsers.map((u) => u.email).join(', ') +
        '. Aborting. This script preserves all accounts with the ADMIN role; remove the extra admin role assignments manually if you want the others deleted.',
    );
  }
  const admin = adminUsers[0];
  const adminHashBefore = admin.passwordHash;

  const counts: Record<string, number> = {};
  for (const model of CLEAN_ORDER) counts[model] = await (prisma[model] as { count(): Promise<number> }).count();
  const usersBefore = await prisma.user.count();

  console.log('Target: local development database (NODE_ENV=' + (process.env.NODE_ENV ?? 'development') + ')');
  console.log('Preserving administrator: ' + admin.email + ' (password hash untouched)');
  console.log('Business data counts before cleanup:', JSON.stringify(counts), '| users:', usersBefore);

  // ---- Cleanup (single transaction; rolls back on any failure) ----
  await prisma.$transaction(async (tx) => {
    // Business records, children before parents (FK-safe order).
    await tx.auditLog.deleteMany({});
    await tx.contactMessage.deleteMany({});
    await tx.newsletterSubscriber.deleteMany({});
    await tx.refund.deleteMany({});
    await tx.returnRequest.deleteMany({});
    await tx.shipment.deleteMany({});
    await tx.payment.deleteMany({});
    await tx.orderStatusEvent.deleteMany({});
    await tx.orderItem.deleteMany({});
    await tx.order.deleteMany({});
    await tx.review.deleteMany({});
    await tx.wishlistItem.deleteMany({});
    await tx.cartItem.deleteMany({});
    await tx.cart.deleteMany({});
    await tx.inventoryMovement.deleteMany({});
    await tx.inventory.deleteMany({});
    await tx.productVariant.deleteMany({});
    await tx.productFeature.deleteMany({});
    await tx.productImage.deleteMany({});
    await tx.product.deleteMany({});
    await tx.collection.deleteMany({});
    await tx.category.deleteMany({});

    // Non-admin test accounts. Cascades remove their tokens, addresses and
    // role assignments. Orders/cart references are already gone above.
    await tx.user.deleteMany({ where: { id: { not: admin.id } } });
  });

  // ---- Verification ----
  const adminAfter = await prisma.user.findUnique({
    where: { id: admin.id },
    select: { email: true, passwordHash: true, isActive: true, roles: { include: { role: true } } },
  });
  if (!adminAfter) throw new Error('VERIFICATION FAILED: administrator was deleted. Rollback did not happen (report this).');
  if (adminAfter.passwordHash !== adminHashBefore) {
    throw new Error('VERIFICATION FAILED: administrator password hash changed.');
  }
  if (!adminAfter.roles.some((r) => r.role.name === 'ADMIN')) {
    throw new Error('VERIFICATION FAILED: administrator lost the ADMIN role.');
  }

  const countsAfter: Record<string, number> = {};
  for (const model of CLEAN_ORDER) countsAfter[model] = await (prisma[model] as { count(): Promise<number> }).count();
  const usersAfter = await prisma.user.count();
  const roles = await prisma.role.findMany({ select: { name: true } });

  console.log('Business data counts after cleanup:', JSON.stringify(countsAfter), '| users:', usersAfter);
  console.log('Administrator preserved: ' + adminAfter.email + ' | ADMIN role: yes | password hash: unchanged');
  console.log('Role definitions preserved: ' + roles.map((r) => r.name).join(', '));
  console.log('Cleanup complete.');
};

run()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
