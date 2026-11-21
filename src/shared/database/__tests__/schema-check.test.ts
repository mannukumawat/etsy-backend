import { describe, expect, it, vi } from 'vitest';

// Pure unit tests for the boot-time schema check (C9). The database is a fake
// object passed in explicitly; the real Prisma client is mocked so importing
// the module never touches a database.
const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'mysql://user:pass@localhost:3306/testdb';
  process.env.JWT_SECRET ??= 'test-only-jwt-secret-0123456789';
  return { prisma: { $queryRawUnsafe: vi.fn() } };
});
vi.mock('../prisma.js', () => ({ prisma: mocks.prisma, assertDatabaseReachable: vi.fn() }));

import { REQUIRED_TABLES, assertRequiredTables, type SchemaCheckDb } from '../schema-check.js';

function fakeDb(existing: string[]): SchemaCheckDb {
  return {
    $queryRawUnsafe: vi.fn(async (_sql: string, ...params: unknown[]) => {
      void _sql;
      return (params as string[])
        .filter((t) => existing.includes(t))
        .map((table_name) => ({ table_name }));
    }),
  } as unknown as SchemaCheckDb;
}

describe('assertRequiredTables (C9)', () => {
  it('resolves when every required table exists', async () => {
    await expect(assertRequiredTables(fakeDb([...REQUIRED_TABLES]))).resolves.toBeUndefined();
  });

  it('checks all ten required tables in a single information_schema query', async () => {
    const db = fakeDb([...REQUIRED_TABLES]);
    await assertRequiredTables(db);
    expect(db.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    const [sql, ...params] = db.$queryRawUnsafe.mock.calls[0] as unknown as [string, ...string[]];
    expect(sql).toContain('information_schema.TABLES');
    expect(params).toEqual(expect.arrayContaining([...REQUIRED_TABLES]));
  });

  it('throws naming the missing table and the migration to run', async () => {
    const existing = [...REQUIRED_TABLES].filter((t) => t !== 'refunds');
    await expect(assertRequiredTables(fakeDb(existing))).rejects.toThrow(
      /missing table\(s\): refunds.*prisma migrate deploy/,
    );
  });

  it('names every missing table when several are absent', async () => {
    await expect(assertRequiredTables(fakeDb(['orders']))).rejects.toThrow(
      /return_requests.*exchange_requests.*customer_bank_accounts/,
    );
  });
});
