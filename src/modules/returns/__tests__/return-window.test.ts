import { describe, expect, it, vi } from 'vitest';

// Pure unit tests for the return-window computation (M4). The helpers live in
// return.service.ts; Prisma is mocked so importing the service never touches a
// database. No updatedAt value is ever an input to the window — the type itself
// has no such field, and the tests below pin the precedence instead.
const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'mysql://user:pass@localhost:3306/testdb';
  process.env.JWT_SECRET ??= 'test-only-jwt-secret-0123456789';
  return {
    prisma: {
      order: { findFirst: vi.fn(), findMany: vi.fn(async () => []) },
      orderLine: { findUnique: vi.fn() },
      orderEvent: { findFirst: vi.fn() },
      product: { findUnique: vi.fn() },
      returnRequest: { findUnique: vi.fn(), findMany: vi.fn(async () => []) },
      returnEvent: { findMany: vi.fn(async () => []), create: vi.fn() },
      refund: { findFirst: vi.fn() },
      customerBankAccount: { findFirst: vi.fn() },
      $queryRawUnsafe: vi.fn(async () => { throw new Error('raw SQL must not be used'); }),
      $executeRawUnsafe: vi.fn(async () => { throw new Error('raw SQL must not be used'); }),
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
    },
  };
});
vi.mock('../../../shared/database/prisma.js', () => ({ prisma: mocks.prisma, assertDatabaseReachable: vi.fn() }));

import {
  DEFAULT_RETURN_WINDOW_DAYS,
  assertWithinDeliveryWindow,
  calculateRefundableAmount,
  findDeliveredEventAt,
  resolveDeliveryWindow,
} from '../return.service.js';

const { prisma } = mocks;

describe('resolveDeliveryWindow (M4)', () => {
  it('prefers the per-line window override over the product default', () => {
    const window = resolveDeliveryWindow({
      deliveredAt: new Date('2026-11-10T00:00:00Z'),
      deliveredEventAt: null,
      lineWindowDays: 14,
      productReturnDays: 30,
    });
    expect(window.windowDays).toBe(14);
  });

  it('falls back to the product returnDays when the line has no override', () => {
    const window = resolveDeliveryWindow({
      deliveredAt: new Date('2026-11-10T00:00:00Z'),
      deliveredEventAt: null,
      lineWindowDays: null,
      productReturnDays: 30,
    });
    expect(window.windowDays).toBe(30);
  });

  it('uses the documented 7-day last resort when neither the line nor the product states one', () => {
    expect(DEFAULT_RETURN_WINDOW_DAYS).toBe(7);
    const window = resolveDeliveryWindow({
      deliveredAt: new Date('2026-11-10T00:00:00Z'),
      deliveredEventAt: null,
      lineWindowDays: null,
      productReturnDays: null,
    });
    expect(window.windowDays).toBe(7);
  });

  it('measures from the line deliveredAt when it exists', () => {
    const deliveredAt = new Date('2026-11-10T12:00:00Z');
    const window = resolveDeliveryWindow({
      deliveredAt,
      deliveredEventAt: new Date('2026-11-12T12:00:00Z'),
      lineWindowDays: null,
      productReturnDays: 30,
    });
    expect(window.deliveredAt).toBe(deliveredAt);
  });

  it('falls back to the delivered event timestamp when the line has no deliveredAt', () => {
    const eventAt = new Date('2026-11-12T12:00:00Z');
    const window = resolveDeliveryWindow({
      deliveredAt: null,
      deliveredEventAt: eventAt,
      lineWindowDays: null,
      productReturnDays: 30,
    });
    expect(window.deliveredAt).toBe(eventAt);
  });
});

describe('assertWithinDeliveryWindow (M4)', () => {
  it('allows a return inside the window measured from deliveredAt', () => {
    const deliveredAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    expect(() => assertWithinDeliveryWindow({ windowDays: 7, deliveredAt }, 'return')).not.toThrow();
  });

  it('rejects a return after the window measured from deliveredAt', () => {
    const deliveredAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    expect(() => assertWithinDeliveryWindow({ windowDays: 7, deliveredAt }, 'return')).toThrow(
      /The 7-day return window for this item has closed/,
    );
  });

  it('uses the resolved window length (line override / product days) in the message', () => {
    const deliveredAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    expect(() => assertWithinDeliveryWindow({ windowDays: 30, deliveredAt }, 'exchange')).toThrow(
      /The 30-day exchange window for this item has closed/,
    );
  });

  it('never measures from order.updatedAt: a stale order write does not close the window', () => {
    // The order may have been written (note added, refund recorded) long after
    // delivery; only the delivery timestamp counts. Delivered 2 days ago with a
    // 7-day window is inside the window no matter when the order was last touched.
    const deliveredAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    expect(() => assertWithinDeliveryWindow({ windowDays: 7, deliveredAt }, 'return')).not.toThrow();
  });

  it('allows the request when no delivery timestamp is on record (legacy delivered orders)', () => {
    expect(() => assertWithinDeliveryWindow({ windowDays: 7, deliveredAt: null }, 'return')).not.toThrow();
  });
});

describe('findDeliveredEventAt (M4 fallback)', () => {
  it('queries the delivered event, not updatedAt', async () => {
    const at = new Date('2026-11-12T09:00:00Z');
    prisma.orderEvent.findFirst.mockResolvedValue({ at });

    await expect(findDeliveredEventAt('ord-1')).resolves.toEqual(at);
    expect(prisma.orderEvent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          orderId: 'ord-1',
          OR: expect.arrayContaining([
            { type: 'delivered' },
            { type: 'fulfilment', message: { startsWith: 'delivered:' } },
          ]),
        }),
      }),
    );
  });

  it('returns null when the order has no delivery event', async () => {
    prisma.orderEvent.findFirst.mockResolvedValue(null);
    await expect(findDeliveredEventAt('ord-1')).resolves.toBeNull();
  });
});

describe('calculateRefundableAmount (unchanged behaviour)', () => {
  it('refunds the exact order total for a single-line full return', () => {
    expect(
      calculateRefundableAmount({ orderTotal: 10000, orderSubtotal: 9000, lineTotal: 9000, lineQuantity: 1, requestedQuantity: 1 }),
    ).toBe(10000);
  });

  it('refunds a proportional share for a partial return', () => {
    // Half of a 9,000 line is 4,500 of the 18,000 subtotal (25%), so 25% of the 20,000 total.
    expect(
      calculateRefundableAmount({ orderTotal: 20000, orderSubtotal: 18000, lineTotal: 9000, lineQuantity: 2, requestedQuantity: 1 }),
    ).toBe(5000);
  });
});
