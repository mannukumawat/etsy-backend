import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hermetic tests for the DB-aggregated dashboard (H13). Prisma is mocked, no
// database is touched. The raw-SQL results use strings for DECIMAL columns, the
// way the MySQL driver returns them, to prove the Number() conversions.

const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
  process.env.JWT_SECRET ??= 'test-only-jwt-secret-0123456789';
  return {
    prisma: {
      $queryRawUnsafe: vi.fn(),
      storeSettings: { findUnique: vi.fn() },
      order: { count: vi.fn(), findMany: vi.fn() },
      customer: { count: vi.fn() },
    },
  };
});
vi.mock('../../../shared/database/prisma.js', () => ({ prisma: mocks.prisma, assertDatabaseReachable: vi.fn() }));

import { getDashboardSummary } from '../dashboard.service.js';

const range = { from: '2026-11-01', to: '2026-11-03' };

describe('getDashboardSummary (H13)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.$queryRawUnsafe.mockImplementation(async (sql: string) => {
      if (sql.includes('COUNT(*) AS totalOrders')) {
        return [
          {
            totalOrders: 10,
            paidOrders: 8,
            cancelledOrders: 1,
            failedOrders: 1,
            grossSalesUsd: '500000',
            refundsUsd: '20000',
            customers: 7,
          },
        ];
      }
      if (sql.includes('DATE(createdAt) AS day')) {
        return [
          { day: new Date('2026-11-01T00:00:00.000Z'), netUsd: '300000', orders: 5 },
          { day: new Date('2026-11-03T00:00:00.000Z'), netUsd: '180000', orders: 3 },
        ];
      }
      if (sql.includes('FROM order_lines')) {
        return [
          { productId: 'p-mug', nameEn: 'Mug', nameHi: '', units: 12, revenueUsd: '400000' },
          { productId: 'p-plate', nameEn: 'Plate', nameHi: '', units: 4, revenueUsd: '80000' },
        ];
      }
      if (sql.includes('FROM product_variants')) {
        return [{ lowStockVariants: 2, outOfStockVariants: 1 }];
      }
      throw new Error(`unexpected SQL in dashboard test: ${sql.slice(0, 80)}`);
    });
    mocks.prisma.storeSettings.findUnique.mockResolvedValue({ lowStockThreshold: 5 });
    mocks.prisma.order.count.mockResolvedValue(3);
    mocks.prisma.customer.count.mockResolvedValue(42);
    mocks.prisma.order.findMany.mockResolvedValue([]);
  });

  it('aggregates totals in the database and keeps the exact response shape', async () => {
    const res = await getDashboardSummary(range);
    expect(res.range).toEqual(range);
    expect(res.totalOrders).toBe(10);
    expect(res.paidOrders).toBe(8);
    expect(res.cancelledOrders).toBe(1);
    expect(res.failedOrders).toBe(1);
    expect(res.grossSalesUsd).toBe(500000);
    expect(res.refundsUsd).toBe(20000);
    expect(res.netRevenueUsd).toBe(480000);
    expect(res.aovUsd).toBe(62500);
    expect(res.customers).toBe(7);
    expect(res.totalRegisteredCustomers).toBe(42);
    expect(res.pendingFulfilment).toBe(3);
    expect(res.lowStockVariants).toBe(2);
    expect(res.outOfStockVariants).toBe(1);
    expect(res.recentOrders).toEqual([]);
  });

  it('fills days without orders with zeros so the series covers the whole range', async () => {
    const res = await getDashboardSummary(range);
    expect(res.salesSeries).toEqual([
      { date: '2026-11-01', netUsd: 300000, orders: 5 },
      { date: '2026-11-02', netUsd: 0, orders: 0 },
      { date: '2026-11-03', netUsd: 180000, orders: 3 },
    ]);
  });

  it('maps top products from the grouped query', async () => {
    const res = await getDashboardSummary(range);
    expect(res.topProducts).toEqual([
      { productId: 'p-mug', name: { en: 'Mug' }, units: 12, revenueUsd: 400000 },
      { productId: 'p-plate', name: { en: 'Plate' }, units: 4, revenueUsd: 80000 },
    ]);
  });

  it('runs a bounded number of queries — no unbounded findMany', async () => {
    await getDashboardSummary(range);
    // 4 raw aggregates + settings + 2 counts + 1 bounded recent-orders read.
    expect(mocks.prisma.$queryRawUnsafe).toHaveBeenCalledTimes(4);
    expect(mocks.prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 5 }),
    );
  });

  it('rejects an invalid range', async () => {
    await expect(getDashboardSummary({ from: '2026-11-03', to: '2026-11-01' })).rejects.toMatchObject({
      status: 400,
    });
  });
});
