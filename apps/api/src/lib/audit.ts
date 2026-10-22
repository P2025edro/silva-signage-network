import type { Db } from '../db.js';

export interface AuditEntry {
  actorType: 'USER' | 'DEVICE' | 'SYSTEM' | 'PROVIDER';
  actorId?: string | null;
  companyId?: string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

/** Append-only (enforced by a database trigger). Call inside the same transaction as the change. */
export async function audit(db: Db, e: AuditEntry): Promise<void> {
  await db`
    INSERT INTO audit_logs (actor_type, actor_id, company_id, action, entity_type, entity_id, metadata, ip)
    VALUES (${e.actorType}, ${e.actorId ?? null}, ${e.companyId ?? null}, ${e.action}, ${e.entityType ?? null},
            ${e.entityId ?? null}, ${db.json((e.metadata ?? {}) as never)}, ${e.ip ?? null})
  `;
}
