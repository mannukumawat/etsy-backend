import { beforeEach, describe, expect, it, vi } from 'vitest';

// Unit tests for stock holds (H5): pure hold math plus the Prisma queries behind
// reservation subtraction, all with a mocked database — no gateway, no real stock.

const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
  process.env.JWT_SECRET ??= 'test-only-jwt-secret-0123456789';
  return {
    stockHold: {
      groupBy: vi.fn(),
      deleteMany: vi.fn(async () => ({ count: 0 })),
      createMany: vi.fn(async () => ({ count: 0 })),
    },
  };
});
vi.mock('../../../shared/database/prisma.js', () => ({ prisma: { stockHold: mocks.stockHold }, assertDatabaseReachable: vi.fn() }));

import {
  availableAfterHolds,
  consumeHolds,
  createHolds,
  HOLD_TTL_MS,
  holdExpiry,
  isHoldExpired,
  reservedQuantities,
} from '../stock-hold.service.js';

const { stockHold } = mocks;

beforeEach(() => {
  vi.clearAllMocks();
  stockHold.deleteMany.mockResolvedValue({ count: 0 });
  stockHold.createMany.mockResolvedValue({ count: 0 });
});

describe('hold expiry math (pure)', () => {
  it('a hold lasts exactly HOLD_TTL_MS (15 minutes)', () => {
    expect(HOLD_TTL_MS).toBe(15 * 60 * 1000);
    const now = new Date('2026-11-21T01:00:00.000Z');
    expect(holdExpiry(now)).toEqual(new Date('2026-11-21T01:15:00.000Z'));
  });

  it('a hold is expired at its expiry instant and live before it', () => {
    const expiry = new Date('2026-11-21T01:15:00.000Z');
    expect(isHoldExpired(expiry, new Date('2026-11-21T01:14:59.999Z'))).toBe(false);
    expect(isHoldExpired(expiry, new Date('2026-11-21T01:15:00.000Z'))).toBe(true);
    expect(isHoldExpired(expiry, new Date('2026-11-21T02:00:00.000Z'))).toBe(true);
  });

  it('availability never goes below zero', () => {
    expect(availableAfterHolds(3, 1)).toBe(2);
    expect(availableAfterHolds(1, 5)).toBe(0);
    expect(availableAfterHolds(0, 0)).toBe(0);
    expect(availableAfterHolds(5, -2)).toBe(5);
  });
});

describe('reservedQuantities', () => {
  it('sums only unexpired holds per variant in one grouped query', async () => {
    stockHold.groupBy.mockResolvedValue([
      { variantId: 'v1', _sum: { quantity: 2 } },
      { variantId: 'v2', _sum: { quantity: 1 } },
    ]);
    const map = await reservedQuantities(['v1', 'v2', 'v3']);
    expect(map.get('v1')).toBe(2);
    expect(map.get('v2')).toBe(1);
    expect(map.has('v3')).toBe(false);
    const where = stockHold.groupBy.mock.calls[0][0].where as Record<string, unknown>;
    expect(where.variantId).toEqual({ in: ['v1', 'v2', 'v3'] });
    expect(where.expiresAt).toEqual({ gt: expect.any(Date) });
  });

  it('returns an empty map without querying when there are no variants', async () => {
    expect(await reservedQuantities([])).toEqual(new Map());
    expect(stockHold.groupBy).not.toHaveBeenCalled();
  });
});

describe('createHolds / consumeHolds', () => {
  it('sweeps expired holds first, then aggregates duplicate lines per variant', async () => {
    const now = new Date('2026-11-21T01:00:00.000Z');
    await createHolds({
      razorpayOrderId: 'order_1',
      customerKey: 'acct:c1',
      lines: [
        { variantId: 'v1', quantity: 1 },
        { variantId: 'v1', quantity: 2 },
        { variantId: 'v2', quantity: 1 },
      ],
      now,
    });
    expect(stockHold.deleteMany).toHaveBeenCalledWith({ where: { expiresAt: { lte: expect.any(Date) } } });
    expect(stockHold.createMany).toHaveBeenCalledWith({
      data: [
        { variantId: 'v1', quantity: 3, razorpayOrderId: 'order_1', customerKey: 'acct:c1', expiresAt: new Date('2026-11-21T01:15:00.000Z') },
        { variantId: 'v2', quantity: 1, razorpayOrderId: 'order_1', customerKey: 'acct:c1', expiresAt: new Date('2026-11-21T01:15:00.000Z') },
      ],
      skipDuplicates: true,
    });
  });

  it('creates no rows when every line has zero quantity', async () => {
    await createHolds({ razorpayOrderId: 'order_1', customerKey: null, lines: [{ variantId: 'v1', quantity: 0 }] });
    expect(stockHold.createMany).not.toHaveBeenCalled();
  });

  it('consumeHolds deletes only the holds for that Razorpay order', async () => {
    const tx = { stockHold };
    await consumeHolds(tx as never, 'order_9');
    expect(stockHold.deleteMany).toHaveBeenCalledWith({ where: { razorpayOrderId: 'order_9' } });
  });
});
