import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hermetic tests for exchange shipment (H4) + price-difference settlement (H16):
// Prisma, the refund service and the low-stock alert are mocked; no database is
// touched and no money moves.
const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'mysql://user:pass@localhost:3306/testdb';
  process.env.JWT_SECRET ??= 'test-only-jwt-secret-0123456789';
  const tx = {
    productVariant: { updateMany: vi.fn(async () => ({ count: 1 })) },
    inventoryAdjustment: { create: vi.fn() },
    exchangeRequest: { update: vi.fn(), updateMany: vi.fn(async () => ({ count: 1 })) },
    exchangeEvent: { findFirst: vi.fn(async (): Promise<{ id: string } | null> => null), create: vi.fn() },
    orderLine: { findUnique: vi.fn(), update: vi.fn() },
  };
  return {
    tx,
    prisma: {
      exchangeRequest: { findUnique: vi.fn(), findMany: vi.fn(async () => []), count: vi.fn(async () => 0), update: vi.fn(), updateMany: vi.fn() },
      exchangeEvent: { findMany: vi.fn(async () => []), findFirst: vi.fn(async (): Promise<{ id: string } | null> => null), create: vi.fn() },
      order: { findUnique: vi.fn() },
      orderLine: { findUnique: vi.fn(), findMany: vi.fn(async () => []) },
      productVariant: { findUnique: vi.fn() },
      inventoryAdjustment: { create: vi.fn() },
      $queryRawUnsafe: vi.fn(async () => { throw new Error('raw SQL must not be used'); }),
      $executeRawUnsafe: vi.fn(async () => { throw new Error('raw SQL must not be used'); }),
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
    },
    issueOrderRefund: vi.fn(async () => ({ id: 'rf-1', reference: 're_test123', status: 'completed' })),
    refundableOf: vi.fn(() => 100000),
    emitLowStockIfCrossed: vi.fn(async () => undefined),
  };
});
vi.mock('../../../shared/database/prisma.js', () => ({ prisma: mocks.prisma, assertDatabaseReachable: vi.fn() }));
vi.mock('../../orders/refund.service.js', () => ({
  issueOrderRefund: mocks.issueOrderRefund,
  refundableOf: mocks.refundableOf,
}));
vi.mock('../../inventory/low-stock-alert.js', () => ({ emitLowStockIfCrossed: mocks.emitLowStockIfCrossed }));

import { recordExchangePayment, shipExchange } from '../admin-exchange.service.js';
import { toAdminExchange } from '../exchange.mapper.js';

const { prisma, tx } = mocks;
const actor = { id: 'owner-1', email: 'owner@example.com' };

const paidOrder = {
  id: 'ord-1',
  number: 'YS-1001',
  total: 100000,
  refundedTotal: 0,
  paymentStatus: 'paid',
  paymentMethod: 'card',
  paymentReference: 'pay_test123',
  currency: 'INR',
  customerId: 'cust-1',
};

const exchangeRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'ex-1',
  reference: 'EXC-ABC123',
  orderId: 'ord-1',
  orderLineId: 'ol-1',
  originalVariantId: 'v-orig',
  replacementVariantId: 'v-repl',
  requestedQty: 5,
  approvedQty: 5,
  reason: 'wrong_size',
  customerNote: null,
  adminNote: null,
  rejectionReason: null,
  status: 'approved',
  priceDifference: 0,
  exchangeWindowDays: 7,
  replacementCarrier: null,
  replacementTracking: null,
  requestedAt: new Date(),
  decidedAt: null,
  shippedAt: null,
  deliveredAt: null,
  closedAt: null,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(mocks.tx));
  mocks.prisma.exchangeRequest.findUnique.mockResolvedValue(exchangeRow());
  mocks.prisma.exchangeEvent.findMany.mockResolvedValue([]);
  mocks.prisma.exchangeEvent.findFirst.mockResolvedValue(null);
  mocks.prisma.order.findUnique.mockResolvedValue(paidOrder);
  tx.exchangeRequest.updateMany.mockResolvedValue({ count: 1 });
  tx.productVariant.updateMany.mockResolvedValue({ count: 1 });
});

describe('shipExchange (H4)', () => {
  it('rejects (does not clamp) when the replacement stock is short at ship time', async () => {
    prisma.productVariant.findUnique.mockResolvedValue({
      stock: 2,
      sku: 'REPL-1',
      product: { id: 'p-1', nameEn: 'Replacement', nameHi: '' },
    });

    await expect(shipExchange('ex-1', { carrier: 'DHL', tracking: 'TRK1' }, actor)).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.inventoryAdjustment.create).not.toHaveBeenCalled();
  });

  it('deducts exactly the approved qty in one transaction and records the actual delta', async () => {
    prisma.productVariant.findUnique.mockResolvedValue({
      stock: 7,
      sku: 'REPL-1',
      product: { id: 'p-1', nameEn: 'Replacement', nameHi: '' },
    });

    await shipExchange('ex-1', { carrier: 'DHL', tracking: 'TRK1' }, actor);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // Conditional decrement: re-checked at ship time, never a blind read-then-write.
    expect(tx.productVariant.updateMany).toHaveBeenCalledWith({
      where: { id: 'v-repl', stock: { gte: 5 } },
      data: { stock: 2 },
    });
    // The history row records the ACTUAL change (7 → 2, delta −5), not a clamped fiction.
    expect(tx.inventoryAdjustment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ before: 7, after: 2, delta: -5, reason: 'exchange_shipped' }),
    });
    // The status update is part of the same transaction (no re-ship double-deduct).
    expect(tx.exchangeRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'ex-1', status: 'approved' },
      data: expect.objectContaining({ status: 'shipped', replacementCarrier: 'DHL', replacementTracking: 'TRK1' }),
    });
  });

  it('uses no raw SQL anywhere in the ship path', async () => {
    prisma.productVariant.findUnique.mockResolvedValue({
      stock: 7,
      sku: 'REPL-1',
      product: { id: 'p-1', nameEn: 'Replacement', nameHi: '' },
    });

    await shipExchange('ex-1', { carrier: 'DHL', tracking: 'TRK1' }, actor);

    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });
});

describe('shipExchange price-difference settlement (H16)', () => {
  const variantInStock = {
    stock: 7,
    sku: 'REPL-1',
    product: { id: 'p-1', nameEn: 'Replacement', nameHi: '' },
  };

  it('blocks shipping while a positive price difference is still due', async () => {
    mocks.prisma.exchangeRequest.findUnique.mockResolvedValue(exchangeRow({ priceDifference: 5000 }));
    prisma.productVariant.findUnique.mockResolvedValue(variantInStock);

    await expect(shipExchange('ex-1', { carrier: 'DHL', tracking: 'TRK1' }, actor)).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringMatching(/5000 INR.*record the payment first/),
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(mocks.issueOrderRefund).not.toHaveBeenCalled();
  });

  it('ships once the payment for a positive difference has been recorded', async () => {
    mocks.prisma.exchangeRequest.findUnique.mockResolvedValue(exchangeRow({ priceDifference: 5000 }));
    mocks.prisma.exchangeEvent.findFirst.mockResolvedValue({ id: 'ev-pay' });
    prisma.productVariant.findUnique.mockResolvedValue(variantInStock);

    await shipExchange('ex-1', { carrier: 'DHL', tracking: 'TRK1' }, actor);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mocks.issueOrderRefund).not.toHaveBeenCalled();
  });

  it('auto-refunds a negative price difference via the original method before shipping', async () => {
    mocks.prisma.exchangeRequest.findUnique.mockResolvedValue(exchangeRow({ priceDifference: -3000 }));
    prisma.productVariant.findUnique.mockResolvedValue(variantInStock);

    await shipExchange('ex-1', { carrier: 'DHL', tracking: 'TRK1' }, actor);

    expect(mocks.issueOrderRefund).toHaveBeenCalledTimes(1);
    expect(mocks.issueOrderRefund).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ord-1', currency: 'INR' }),
      expect.objectContaining({ amount: 3000, method: 'original' }),
      'owner@example.com',
    );
    // The refund is marked done, so a retried shipment cannot refund it again.
    expect(prisma.exchangeEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: 'refund_issued' }) }),
    );
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('refunds a negative difference to the wallet for wallet-paid orders', async () => {
    mocks.prisma.exchangeRequest.findUnique.mockResolvedValue(exchangeRow({ priceDifference: -3000 }));
    mocks.prisma.order.findUnique.mockResolvedValue({ ...paidOrder, paymentMethod: 'wallet', paymentReference: null });
    prisma.productVariant.findUnique.mockResolvedValue(variantInStock);

    await shipExchange('ex-1', { carrier: 'DHL', tracking: 'TRK1' }, actor);

    expect(mocks.issueOrderRefund).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ amount: 3000, method: 'store_credit' }),
      'owner@example.com',
    );
  });

  it('does not refund the same negative difference twice on a retried shipment', async () => {
    mocks.prisma.exchangeRequest.findUnique.mockResolvedValue(exchangeRow({ priceDifference: -3000 }));
    // The first attempt already recorded the refund.
    mocks.prisma.exchangeEvent.findFirst.mockResolvedValueOnce({ id: 'ev-refund' });
    prisma.productVariant.findUnique.mockResolvedValue(variantInStock);

    await shipExchange('ex-1', { carrier: 'DHL', tracking: 'TRK1' }, actor);

    expect(mocks.issueOrderRefund).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe('recordExchangePayment', () => {
  it('records the payment reference as an event and clears the amount due', async () => {
    mocks.prisma.exchangeRequest.findUnique.mockResolvedValue(exchangeRow({ priceDifference: 5000 }));
    mocks.prisma.exchangeEvent.findFirst.mockResolvedValue(null);

    const { row, events } = await recordExchangePayment('ex-1', { reference: 'BANK-REF-1', note: 'Paid by bank transfer.' }, actor);

    expect(prisma.exchangeEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'payment_recorded',
          message: expect.stringContaining('BANK-REF-1'),
        }),
      }),
    );
    // The admin view now shows nothing due: the timeline carries the payment event.
    const recorded = [{ id: 'ev-pay', exchange_id: 'ex-1', type: 'payment_recorded', actor: 'admin', actor_id: 'owner-1', message: 'Payment of 5000 INR recorded (reference: BANK-REF-1).', created_at: new Date() }];
    expect(toAdminExchange(row!, recorded).amountDue).toBe(0);
    expect(events).toBeDefined();
  });

  it('shows the amount due in the admin view until the payment is recorded', () => {
    const row = exchangeRow({ priceDifference: 5000 });
    const mapped = {
      id: row.id, reference: row.reference, order_id: row.orderId, order_line_id: row.orderLineId,
      original_variant_id: row.originalVariantId, replacement_variant_id: row.replacementVariantId,
      requested_qty: 5, approved_qty: 5, reason: 'wrong_size', customer_note: null, admin_note: null,
      rejection_reason: null, status: 'approved', price_difference: 5000, exchange_window_days: 7,
      replacement_carrier: null, replacement_tracking: null, requested_at: new Date(),
      decided_at: null, shipped_at: null, delivered_at: null, closed_at: null,
    };
    expect(toAdminExchange(mapped, []).amountDue).toBe(5000);
  });

  it('rejects recording a payment when nothing is due', async () => {
    mocks.prisma.exchangeRequest.findUnique.mockResolvedValue(exchangeRow({ priceDifference: 0 }));

    await expect(recordExchangePayment('ex-1', { reference: 'BANK-REF-1' }, actor)).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(prisma.exchangeEvent.create).not.toHaveBeenCalled();
  });

  it('rejects a second payment recording for the same exchange', async () => {
    mocks.prisma.exchangeRequest.findUnique.mockResolvedValue(exchangeRow({ priceDifference: 5000 }));
    mocks.prisma.exchangeEvent.findFirst.mockResolvedValue({ id: 'ev-pay' });

    await expect(recordExchangePayment('ex-1', { reference: 'BANK-REF-2' }, actor)).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(prisma.exchangeEvent.create).not.toHaveBeenCalled();
  });
});
