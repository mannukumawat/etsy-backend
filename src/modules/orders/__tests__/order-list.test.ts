import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hermetic tests for server-side orders pagination (C6): Prisma is mocked, no
// database is touched. Verifies the 500-row cap is gone, filters/sort/page are
// honoured, and the count and the page query use the same WHERE clause.

const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
  process.env.JWT_SECRET ??= 'test-only-jwt-secret-0123456789';
  const ids = Array.from({ length: 45 }, (_, i) => ({ id: `order_${String(i + 1).padStart(2, '0')}` }));
  return {
    ids,
    prisma: {
      $queryRawUnsafe: vi.fn(),
      order: { findMany: vi.fn() },
      refund: { findMany: vi.fn(async () => []) },
    },
  };
});
vi.mock('../../../shared/database/prisma.js', () => ({ prisma: mocks.prisma, assertDatabaseReachable: vi.fn() }));

import { listOrders, type OrderListQuery } from '../order.service.js';

const { prisma, ids } = mocks;

const baseQuery: OrderListQuery = {
  q: '',
  status: '',
  payment: '',
  currency: '',
  customer: '',
  from: '',
  to: '',
  pending: false,
  paidOnly: false,
  sort: 'date',
  dir: 'desc',
  page: 1,
  pageSize: 20,
};

function mockList(total = 45) {
  prisma.$queryRawUnsafe.mockImplementation(async (sql: string, ...args: unknown[]) => {
    if (sql.startsWith('SELECT COUNT(*)')) return [{ total }];
    if (sql.startsWith('SELECT id FROM orders')) {
      const limit = args[args.length - 2] as number;
      const offset = args[args.length - 1] as number;
      return ids.slice(offset, Math.min(offset + limit, total));
    }
    return []; // loadLineExtras
  });
  prisma.order.findMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
    where.id.in.map((id) => ({ id })),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('listOrders (C6)', () => {
  it('returns the first page of 20 with total/pageCount instead of a 500 cap', async () => {
    mockList(45);
    const result = await listOrders(baseQuery);

    expect(result.total).toBe(45);
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(20);
    expect(result.pageCount).toBe(3);
    expect(result.rows).toHaveLength(20);
    // The page query asks for exactly one page, with an offset.
    const pageCall = prisma.$queryRawUnsafe.mock.calls.find((c) => String(c[0]).startsWith('SELECT id FROM orders'))!;
    expect(pageCall[pageCall.length - 2]).toBe(20); // LIMIT
    expect(pageCall[pageCall.length - 1]).toBe(0); // OFFSET
  });

  it('pages forward: page 3 returns the last 5 of 45', async () => {
    mockList(45);
    const result = await listOrders({ ...baseQuery, page: 3 });
    expect(result.page).toBe(3);
    expect(result.rows).toHaveLength(5);
    const pageCall = prisma.$queryRawUnsafe.mock.calls.find((c) => String(c[0]).startsWith('SELECT id FROM orders'))!;
    expect(pageCall[pageCall.length - 1]).toBe(40);
  });

  it('clamps a page past the end to the last page', async () => {
    mockList(45);
    const result = await listOrders({ ...baseQuery, page: 99 });
    expect(result.page).toBe(3);
  });

  it('applies filters to the count and the page query identically (C6)', async () => {
    mockList(7);
    await listOrders({ ...baseQuery, status: 'shipped', payment: 'paid', currency: 'INR', customer: 'guest', from: '2026-11-01', to: '2026-11-20', pending: false, paidOnly: false });

    const [countSql, ...countParams] = prisma.$queryRawUnsafe.mock.calls[0];
    const pageCall = prisma.$queryRawUnsafe.mock.calls.find((c) => String(c[0]).startsWith('SELECT id FROM orders'))!;
    const [pageSql, ...pageParams] = pageCall;
    expect(String(countSql)).toContain('fulfilmentStatus = ?');
    expect(String(countSql)).toContain('paymentStatus = ?');
    expect(String(countSql)).toContain('currency = ?');
    expect(String(countSql)).toContain('customerKind = ?');
    expect(String(countSql)).toContain('createdAt >=');
    expect(String(countSql)).toContain('createdAt < DATE_ADD');
    // Same WHERE params in both calls (page call appends LIMIT/OFFSET after them).
    expect(pageParams.slice(0, countParams.length)).toEqual(countParams);
    expect(String(pageSql)).toContain('ORDER BY createdAt DESC');
  });

  it('maps pending/paidOnly to the right payment+fulfilment conditions', async () => {
    mockList(2);
    await listOrders({ ...baseQuery, pending: true });
    expect(String(prisma.$queryRawUnsafe.mock.calls[0][0])).toContain(`paymentStatus IN ('paid', 'partially_refunded')`);
    expect(String(prisma.$queryRawUnsafe.mock.calls[0][0])).toContain(`fulfilmentStatus IN ('unfulfilled', 'processing')`);

    vi.clearAllMocks();
    mockList(2);
    await listOrders({ ...baseQuery, paidOnly: true });
    expect(String(prisma.$queryRawUnsafe.mock.calls[0][0])).toContain(`paymentStatus IN ('paid', 'partially_refunded', 'refunded')`);
  });

  it('sorts by USD-equivalent total through the stored rate snapshot, not raw total', async () => {
    mockList(45);
    await listOrders({ ...baseQuery, sort: 'total', dir: 'asc' });
    const pageCall = prisma.$queryRawUnsafe.mock.calls.find((c) => String(c[0]).startsWith('SELECT id FROM orders'))!;
    const sql = String(pageCall[0]);
    expect(sql).toContain('JSON_EXTRACT(rateSnapshotJson');
    expect(sql).toContain('ORDER BY (total /');
    expect(sql).toContain(' ASC');
  });

  it('searches number, email and name with escaped LIKE wildcards', async () => {
    mockList(1);
    await listOrders({ ...baseQuery, q: '100%_x' });
    const countParams = prisma.$queryRawUnsafe.mock.calls[0].slice(1) as unknown[];
    expect(countParams).toEqual(['%100\\%\\_x%', '%100\\%\\_x%', '%100\\%\\_x%']);
  });

  it('returns an empty page (not an error) when nothing matches', async () => {
    mockList(0);
    const result = await listOrders(baseQuery);
    expect(result).toMatchObject({ total: 0, page: 1, pageCount: 1, rows: [] });
    expect(prisma.order.findMany).not.toHaveBeenCalled();
  });
});
