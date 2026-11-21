import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hermetic tests for real refunds (C7): Prisma, the Razorpay client and the wallet
// service are mocked; no database is touched and no money moves.

const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
  process.env.JWT_SECRET ??= 'test-only-jwt-secret-0123456789';
  // Tiny in-memory fake for the `refunds` table via the Prisma `refund` model:
  // create stores the row, update applies the data fields, findUnique/findMany
  // read it back — so tests assert end state.
  const table = new Map<string, Record<string, unknown>>();
  const refundModel = {
    create: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
  };
  const tx = {
    order: { updateMany: vi.fn(async () => ({ count: 1 })) },
    orderEvent: { create: vi.fn() },
    refund: refundModel,
  };
  return {
    table,
    tx,
    refundModel,
    prisma: {
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
      order: { findUnique: vi.fn() },
      refund: refundModel,
    },
    gatewayRefund: vi.fn(),
    isRazorpayConfigured: vi.fn(() => true),
    creditWallet: vi.fn(async () => ({ newBalance: 5000, txId: 'wtx1' })),
  };
});
vi.mock('../../../shared/database/prisma.js', () => ({ prisma: mocks.prisma, assertDatabaseReachable: vi.fn() }));
vi.mock('../../checkout/payment.service.js', () => ({
  isRazorpayConfigured: mocks.isRazorpayConfigured,
  refundRazorpayPayment: mocks.gatewayRefund,
}));
vi.mock('../../wallet/wallet.service.js', () => ({ creditWallet: mocks.creditWallet }));

import { issueOrderRefund, listRefundsForOrders, toRefundView, verifyManualRefund, type OrderLike } from '../refund.service.js';

const { prisma, table, tx, gatewayRefund } = mocks;

function wireFakeRefunds() {
  const { refundModel } = mocks;
  refundModel.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    const row = {
      ...data,
      completedAt: null,
      failedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    table.set(data.id as string, row);
    return row;
  });
  refundModel.update.mockImplementation(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
    const row = table.get(where.id);
    if (!row) throw new Error('Refund not found.');
    Object.assign(row, data);
    return row;
  });
  refundModel.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => table.get(where.id) ?? null);
  refundModel.findMany.mockImplementation(async ({ where }: { where: { orderId: { in: string[] } } }) =>
    [...table.values()]
      .filter((r) => where.orderId.in.includes(r.orderId as string))
      .sort((a, b) => (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime()),
  );
}

const paidOrder = (over: Partial<OrderLike> = {}): OrderLike => ({
  id: 'ord_1',
  number: 'YS-1001',
  total: 20000,
  refundedTotal: 0,
  paymentStatus: 'paid',
  paymentMethod: 'card',
  paymentReference: 'pay_test123',
  currency: 'INR',
  customerId: 'cust_1',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  table.clear();
  mocks.isRazorpayConfigured.mockReturnValue(true);
  prisma.order.findUnique.mockReset();
  mocks.prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx));
  tx.order.updateMany.mockResolvedValue({ count: 1 });
  gatewayRefund.mockResolvedValue({ id: 'rfnd_test123', status: 'processed' });
  wireFakeRefunds();
});

describe('issueOrderRefund — original (Razorpay)', () => {
  it('refunds the full amount through Razorpay and marks it completed with the gateway id', async () => {
    const refund = await issueOrderRefund(paidOrder(), { amount: 20000, reason: 'Damaged', method: 'original' }, 'owner@test.example');

    expect(gatewayRefund).toHaveBeenCalledWith('pay_test123', 20000, expect.objectContaining({ order: 'YS-1001' }));
    expect(refund).toMatchObject({ status: 'completed', method: 'original', reference: 'rfnd_test123', amount: 20000 });
    // Atomic guard: totals only move when refundedTotal + amount fits the total.
    expect(tx.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'ord_1', refundedTotal: { lte: 0 } } }),
    );
    expect(tx.orderEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ message: expect.stringContaining('rfnd_test123') }) }),
    );
  });

  it('handles a partial refund: payment becomes partially_refunded', async () => {
    await issueOrderRefund(paidOrder(), { amount: 5000, reason: 'Goodwill', method: 'original' }, 'owner@test.example');
    expect(tx.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { refundedTotal: 5000, paymentStatus: 'partially_refunded' } }),
    );
  });

  it('refunds in the order currency — no conversion, same method as the charge', async () => {
    const eur = paidOrder({ currency: 'EUR', paymentMethod: 'card' });
    await issueOrderRefund(eur, { amount: 7000, reason: 'Return', method: 'original' }, 'owner@test.example');
    // The gateway gets the raw minor-unit amount; the currency is the payment's own.
    expect(gatewayRefund).toHaveBeenCalledWith('pay_test123', 7000, expect.anything());
  });

  it('on gateway failure the row is marked failed and the totals never move', async () => {
    gatewayRefund.mockRejectedValue(new Error('Payment not found'));
    await expect(
      issueOrderRefund(paidOrder(), { amount: 5000, reason: 'Return', method: 'original' }, 'owner@test.example'),
    ).rejects.toMatchObject({ status: 502, code: 'gateway_error' });
    const row = table.values().next().value as Record<string, unknown>;
    expect(row.status).toBe('failed');
    expect(row.failedAt).not.toBeNull();
    expect(tx.order.updateMany).not.toHaveBeenCalled();
  });

  it('refuses when the order has no stored Razorpay payment reference', async () => {
    await expect(
      issueOrderRefund(paidOrder({ paymentReference: '' }), { amount: 5000, reason: 'Return', method: 'original' }, 'owner@test.example'),
    ).rejects.toThrow('no stored Razorpay payment reference');
    expect(gatewayRefund).not.toHaveBeenCalled();
  });

  it('refuses when Razorpay is not configured', async () => {
    mocks.isRazorpayConfigured.mockReturnValue(false);
    await expect(
      issueOrderRefund(paidOrder(), { amount: 5000, reason: 'Return', method: 'original' }, 'owner@test.example'),
    ).rejects.toThrow('Razorpay is not configured');
    expect(gatewayRefund).not.toHaveBeenCalled();
  });

  it('refuses a wallet-paid order for the original method (use store credit)', async () => {
    await expect(
      issueOrderRefund(paidOrder({ paymentMethod: 'wallet', paymentReference: '' }), { amount: 5000, reason: 'Return', method: 'original' }, 'owner@test.example'),
    ).rejects.toThrow('store credit');
    expect(gatewayRefund).not.toHaveBeenCalled();
  });

  it('a gateway reply of "processing" leaves the row processing and the totals untouched', async () => {
    gatewayRefund.mockResolvedValue({ id: 'rfnd_test999', status: 'processing' });
    const refund = await issueOrderRefund(paidOrder(), { amount: 5000, reason: 'Return', method: 'original' }, 'owner@test.example');
    expect(refund.status).toBe('processing');
    expect(tx.order.updateMany).not.toHaveBeenCalled();
  });

  it('rejects an over-refund before touching the gateway', async () => {
    await expect(
      issueOrderRefund(paidOrder({ refundedTotal: 15000 }), { amount: 6000, reason: 'Return', method: 'original' }, 'owner@test.example'),
    ).rejects.toThrow('more than the remaining');
    expect(gatewayRefund).not.toHaveBeenCalled();
  });

  it('rejects refunding an unpaid order', async () => {
    await expect(
      issueOrderRefund(paidOrder({ paymentStatus: 'unpaid' }), { amount: 100, reason: 'Return', method: 'original' }, 'owner@test.example'),
    ).rejects.toThrow('has not been paid');
  });

  it('a concurrent refund that trips the atomic guard surfaces as a conflict', async () => {
    tx.order.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      issueOrderRefund(paidOrder(), { amount: 5000, reason: 'Return', method: 'original' }, 'owner@test.example'),
    ).rejects.toThrow('concurrent refund');
  });
});

describe('issueOrderRefund — manual + store credit', () => {
  it('manual refunds stay pending with their reference and do not move totals', async () => {
    const refund = await issueOrderRefund(
      paidOrder(),
      { amount: 8000, reason: 'Bank transfer', method: 'manual_bank', reference: 'UTR123456' },
      'owner@test.example',
    );
    expect(refund).toMatchObject({ status: 'pending', method: 'manual_bank', reference: 'UTR123456' });
    expect(gatewayRefund).not.toHaveBeenCalled();
    expect(tx.order.updateMany).not.toHaveBeenCalled();
  });

  it('manual refunds require a reference', async () => {
    await expect(
      issueOrderRefund(paidOrder(), { amount: 8000, reason: 'Bank transfer', method: 'manual_upi' }, 'owner@test.example'),
    ).rejects.toThrow('reference is required');
  });

  it('store-credit refunds credit the wallet atomically and complete at once', async () => {
    const refund = await issueOrderRefund(
      paidOrder({ paymentMethod: 'wallet', paymentReference: '' }),
      { amount: 4000, reason: 'Return', method: 'store_credit' },
      'owner@test.example',
    );
    expect(refund.status).toBe('completed');
    expect(mocks.creditWallet).toHaveBeenCalledWith('cust_1', 4000, 'refund', expect.stringContaining('refund:order:'), expect.anything());
    expect(tx.order.updateMany).toHaveBeenCalled();
  });

  it('store-credit refunds refuse guest orders', async () => {
    await expect(
      issueOrderRefund(paidOrder({ customerId: null }), { amount: 4000, reason: 'Return', method: 'store_credit' }, 'owner@test.example'),
    ).rejects.toThrow('guest order');
  });
});

describe('verifyManualRefund', () => {
  it('completes a pending manual refund and only then moves the totals', async () => {
    const pending = await issueOrderRefund(
      paidOrder(),
      { amount: 8000, reason: 'Bank transfer', method: 'manual_bank', reference: 'UTR123456' },
      'owner@test.example',
    );
    prisma.order.findUnique.mockResolvedValue({ ...paidOrder(), refundedTotal: 0 });

    const verified = await verifyManualRefund(pending.id);
    expect(verified.status).toBe('completed');
    expect(verified.completedAt).not.toBeNull();
    expect(tx.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { refundedTotal: 8000, paymentStatus: 'partially_refunded' } }),
    );
  });

  it('refuses to verify a refund that is already completed', async () => {
    const pending = await issueOrderRefund(
      paidOrder(),
      { amount: 8000, reason: 'Bank transfer', method: 'manual_bank', reference: 'UTR123456' },
      'owner@test.example',
    );
    prisma.order.findUnique.mockResolvedValue({ ...paidOrder(), refundedTotal: 0 });
    await verifyManualRefund(pending.id);
    await expect(verifyManualRefund(pending.id)).rejects.toThrow("already 'completed'");
  });

  it('refuses to verify a gateway refund', async () => {
    const done = await issueOrderRefund(paidOrder(), { amount: 5000, reason: 'Return', method: 'original' }, 'owner@test.example');
    await expect(verifyManualRefund(done.id)).rejects.toThrow('Only manual');
  });

  it('returns 404 for an unknown refund id', async () => {
    await expect(verifyManualRefund('nope')).rejects.toMatchObject({ status: 404 });
  });
});

describe('listRefundsForOrders', () => {
  it('loads every refund for a set of orders in one query', async () => {
    await issueOrderRefund(paidOrder(), { amount: 5000, reason: 'A', method: 'original' }, 'owner@test.example');
    await issueOrderRefund(paidOrder({ id: 'ord_2', number: 'YS-1002' }), { amount: 1000, reason: 'B', method: 'manual_upi', reference: 'U1' }, 'owner@test.example');
    const map = await listRefundsForOrders(['ord_1', 'ord_2']);
    expect(map.get('ord_1')).toHaveLength(1);
    expect(map.get('ord_2')).toHaveLength(1);
    expect(map.get('ord_2')![0].status).toBe('pending');
    expect(prisma.refund.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orderId: { in: ['ord_1', 'ord_2'] } } }),
    );
  });

  it('returns an empty map without querying when there are no orders', async () => {
    const map = await listRefundsForOrders([]);
    expect(map.size).toBe(0);
    expect(prisma.refund.findMany).not.toHaveBeenCalled();
  });
});

describe('toRefundView', () => {
  it('maps a raw row to the admin shape', () => {
    expect(
      toRefundView({
        id: 'r1', order_id: 'ord_1', return_id: null, amount: 100, reason: 'x', method: 'original',
        status: 'completed', reference: 'rfnd_1', completed_at: new Date('2026-11-20T10:00:00.000Z'),
        failed_at: null, recorded_by: 'owner@test.example', note: null,
        created_at: new Date('2026-11-20T09:00:00.000Z'), updated_at: new Date(),
      }),
    ).toMatchObject({ id: 'r1', orderId: 'ord_1', status: 'completed', completedAt: '2026-11-20T10:00:00.000Z' });
  });
});
