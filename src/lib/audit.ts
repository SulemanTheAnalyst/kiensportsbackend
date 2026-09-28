import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';

// Every administrative mutation writes an AuditLog entry.
export const audit = (
  actorId: string | null | undefined,
  action: string,
  entity: string,
  entityId?: string,
  diff?: unknown,
  ip?: string,
) =>
  prisma.auditLog.create({
    data: {
      actorId: actorId ?? null,
      action,
      entity,
      entityId: entityId ?? null,
      diff: (diff ?? undefined) as Prisma.InputJsonValue | undefined,
      ip: ip ?? null,
    },
  }).catch(() => undefined); // audit must never break the main flow
