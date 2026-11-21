import { prisma } from './prisma.js';

/**
 * Boot-time schema check (C9). The returns / exchanges / refunds tables used to be
 * created by one-shot scripts that nothing ever ran, so a fresh deploy could boot
 * with the code expecting tables that do not exist. This check fails fast with the
 * missing table names and the migration to run, instead of failing later with a
 * cryptic query error on the first return, exchange or refund.
 *
 * Wired into the /health handler by the coordinator (see the snippet in the
 * handover report) — this module intentionally has no side effects on import.
 */
export const REQUIRED_TABLES = [
  'return_requests',
  'return_events',
  'refunds',
  'exchange_requests',
  'exchange_events',
  'customer_bank_accounts',
  'contact_messages',
  'stock_holds',
  'revoked_sessions',
  'razorpay_orders',
] as const;

/** Minimal database surface this check needs, so tests can pass a fake. */
export interface SchemaCheckDb {
  $queryRawUnsafe<T>(sql: string, ...params: unknown[]): Promise<T>;
}

/**
 * Throws when any required table is missing, naming the missing tables and the
 * migration to run. A single information_schema query checks all tables at once.
 */
export async function assertRequiredTables(db: SchemaCheckDb = prisma): Promise<void> {
  const placeholders = REQUIRED_TABLES.map(() => '?').join(',');
  const rows = await db.$queryRawUnsafe<Array<{ table_name: string }>>(
    `SELECT TABLE_NAME AS table_name FROM information_schema.TABLES ` +
      `WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${placeholders})`,
    ...REQUIRED_TABLES,
  );
  const found = new Set(rows.map((r) => r.table_name));
  const missing = REQUIRED_TABLES.filter((t) => !found.has(t));
  if (missing.length > 0) {
    throw new Error(
      `Database schema is incomplete: missing table(s): ${missing.join(', ')}. ` +
        `Run the pending Prisma migration ('npx prisma migrate deploy') and restart the server.`,
    );
  }
}
