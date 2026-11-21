import { beforeEach, describe, expect, it, vi } from 'vitest';

// Unit tests for the order webhook's failed-payment reconciliation (C1): Prisma is
// mocked, no database or Razorpay call happens.

const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
  process.env.JWT_SECRET ??= 'test-only-jwt-secret-0123456789';
  const tx = {
    orderEvent: { create: vi.fn() },
    order: { update: vi.fn() },
  };
  return {
    tx,
    prisma: {
      order: { findFirst: vi.fn() },
      walletTopup: { findFirst: vi.fn() },
      $executeRawUnsafe: vi.fn(),
      $queryRawUnsafe: vi.fn(),
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
    },
  };
});
vi.mock('../../../shared/database/prisma.js', () => ({ prisma: mocks.prisma, assertDatabaseReachable: vi.fn() }));

import { recordCapturedPayment, recordFailedPayment } from '../payment-recovery.service.js';

const { prisma, tx } = mocks;

beforeEach(() => {
  vi.clearAllMocks();
  prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx));
});

describe('recordFailedPayment (C1)', () => {
  it('marks an unpaid order failed and records the event', async () => {
    prisma.order.findFirst.mockResolvedValue({ id: 'o1', number: 'YS-1001', paymentStatus: 'unpaid' });
    const result = await recordFailedPayment({ razorpayPaymentId: 'pay_1', razorpayOrderId: 'order_1' });
    expect(result).toEqual({ matched: true, orderNumber: 'YS-1001', markedFailed: true });
    expect(tx.order.update).toHaveBeenCalledWith({ where: { id: 'o1' }, data: { paymentStatus: 'failed' } });
    expect(tx.orderEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: 'payment_failed' }) }),
    );
  });

  it('never flips a paid order to failed — it only records the event', async () => {
    prisma.order.findFirst.mockResolvedValue({ id: 'o1', number: 'YS-1001', paymentStatus: 'paid' });
    const result = await recordFailedPayment({ razorpayPaymentId: 'pay_1', razorpayOrderId: 'order_1' });
    expect(result).toEqual({ matched: true, orderNumber: 'YS-1001', markedFailed: false });
    expect(tx.order.update).not.toHaveBeenCalled();
    expect(tx.orderEvent.create).toHaveBeenCalled();
  });

  it('ignores a failed payment with no matching order (no money moved)', async () => {
    prisma.order.findFirst.mockResolvedValue(null);
    const result = await recordFailedPayment({ razorpayPaymentId: 'pay_1', razorpayOrderId: 'order_1' });
    expect(result).toEqual({ matched: false, markedFailed: false });
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(tx.orderEvent.create).not.toHaveBeenCalled();
  });
});

describe('recordCapturedPayment — razorpayOrderId fallback (C2)', () => {
  it('matches by razorpayOrderId when the payment id alone does not match', async () => {
    prisma.order.findFirst.mockResolvedValue({ id: 'o1', number: 'YS-1002' });
    const result = await recordCapturedPayment({
      razorpayPaymentId: 'pay_new',
      razorpayOrderId: 'order_1',
      amount: 20000,
      currency: 'INR',
      customerEmail: 'a@example.com',
    });
    expect(result).toEqual({ matched: true, recoveryId: null, orderNumber: 'YS-1002' });
    const where = prisma.order.findFirst.mock.calls[0][0].where as Record<string, unknown>;
    expect(where.OR).toEqual([{ paymentReference: 'pay_new' }, { razorpayOrderId: 'order_1' }]);
  });
});
