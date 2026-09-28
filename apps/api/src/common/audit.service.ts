import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Tx } from '../prisma/prisma.service';

export interface AuditEntry {
  actorId: string;
  action: string;
  entity: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
}

/** Ghi audit_log cho mọi thao tác nhạy cảm (mục 9), luôn trong cùng transaction với thao tác. */
@Injectable()
export class AuditService {
  record(tx: Tx, e: AuditEntry) {
    return tx.auditLog.create({
      data: {
        actorId: e.actorId,
        action: e.action,
        entity: e.entity,
        entityId: e.entityId,
        before: (e.before ?? undefined) as Prisma.InputJsonValue | undefined,
        after: (e.after ?? undefined) as Prisma.InputJsonValue | undefined,
        reason: e.reason,
      },
    });
  }
}
