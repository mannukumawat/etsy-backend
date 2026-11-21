import { beforeEach, describe, expect, it, vi } from 'vitest';

// Unit tests for markOrderPaid proof requirements (M5): Prisma is mocked.

const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
  process.env.JWT_SECRET ??= 'test-only-jwt-secret-0123456789';
  return {
    prisma: {
      order: { findUnique: vi.fn(), update: vi.fn(async (args: unknown) => args) },
    },
  };
});
vi.mock('../../../shared/database/prisma.js', () => ({ prisma: mocks.prisma, assertDatabaseReachable: vi.fn() }));

import { markOrderPaid } from '../order.service.js';

const { prisma } = mocks;

const unpaidOrder = {
  id: 'ord_1',
  paymentStatus: 'unpaid',
  fulfilmentStatus: 'unfulfilled',
};

beforeEach(() => {
  vi.clearAllMocks();
  prisma.order.findUnique.mockResolvedValue({ ...unpaidOrder });
});

describe('markOrderPaid (M5)', () => {
  it('marks paid with a payment reference and records it on the order', async () => {
    await markOrderPaid('ord_1', { paymentReference: 'pay_123' });
    expect(prisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'ord_1' },
        data: expect.objectContaining({
          paymentStatus: 'paid',
          paymentReference: 'pay_123',
          events: { create: [{ type: 'payment', message: expect.stringContaining('pay_123'), actor: 'admin' }] },
        }),
      }),
    );
  });

  it('refuses with no reference and no override', async () => {
    await expect(markOrderPaid('ord_1', {})).rejects.toThrow('payment reference is required');
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  it('allows a forced manual reconciliation with an audit note, and records the note', async () => {
    await markOrderPaid('ord_1', { force: true, note: 'Verified in the Razorpay dashboard.' }, 'owner@test.example');
    const updateCall = prisma.order.update.mock.calls[0] as unknown as [{ data: Record<string, unknown> }];
    const data = updateCall[0].data;
    expect(data.paymentStatus).toBe('paid');
    const message = (data.events as { create: Array<{ message: string }> }).create[0].message;
    expect(message).toMatch(/manual reconciliation without a payment reference/);
    expect(message).toMatch(/Verified in the Razorpay dashboard/);
    expect(data.notes).toEqual({
      create: [{ author: 'owner@test.example', body: expect.stringContaining('Verified in the Razorpay dashboard') }],
    });
  });

  it('a forced reconciliation without an audit note is refused', async () => {
    await expect(markOrderPaid('ord_1', { force: true })).rejects.toThrow('audit note');
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  it('still refuses paid or cancelled orders', async () => {
    prisma.order.findUnique.mockResolvedValue({ ...unpaidOrder, paymentStatus: 'paid' });
    await expect(markOrderPaid('ord_1', { paymentReference: 'pay_1' })).rejects.toThrow('unpaid');
  });
});
