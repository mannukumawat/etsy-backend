// Minimal admin audit log (H7): a durable record of destructive owner actions, written
// in the SAME transaction as the action itself, so a logged action that rolls back
// leaves no log row and a completed action always has one. The table is append-only
// (raw SQL, like `refunds` — no Prisma model); there is no delete/update path.
import { randomHexId } from './ids.js';

export interface AuditLogEntry {
  actor: string;
  action: string;
  targetType: string;
  targetId: string | null;
  detail: string;
}

type AuditDb = {
  $executeRawUnsafe: (sql: string, ...params: unknown[]) => Promise<number>;
};

/** Inserts one audit row. `db` is the transaction client when called inside a $transaction. */
export async function recordAuditLog(db: AuditDb, entry: AuditLogEntry): Promise<void> {
  await db.$executeRawUnsafe(
    `INSERT INTO admin_audit_log (id, actor, action, target_type, target_id, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NOW(3))`,
    randomHexId(12),
    entry.actor,
    entry.action,
    entry.targetType,
    entry.targetId,
    entry.detail,
  );
}
