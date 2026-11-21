import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hermetic tests for the return create / withdraw transactions (H15): Prisma is
// mocked, no database is touched, and the raw-SQL methods throw if called, so
// any surviving raw SQL fails the test instead of silently passing.
const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'mysql://user:pass@localhost:3306/testdb';
  process.env.JWT_SECRET ??= 'test-only-jwt-secret-0123456789';
  const tx = {
    orderLine: {
      findUnique: vi.fn(async () => ({ quantity: 2, cancelledQty: 0, returnedQty: 0 })),
      update: vi.fn(),
    },
    returnRequest: { findMany: vi.fn(async () => []), create: vi.fn(), update: vi.fn() },
    returnEvent: { create: vi.fn() },
    orderEvent: { create: vi.fn() },
  };
  return {
    tx,
    prisma: {
      order: {
        findFirst: vi.fn(),
        findMany: vi.fn(async () => []),
      },
      orderLine: { findUnique: vi.fn() },
      orderEvent: { findFirst: vi.fn(async () => null) },
      product: { findUnique: vi.fn() },
      returnRequest: { findUnique: vi.fn(), findMany: vi.fn(async () => []), create: vi.fn() },
      returnEvent: { findMany: vi.fn(async () => []), create: vi.fn() },
      refund: { findFirst: vi.fn(async () => null) },
      customerBankAccount: { findFirst: vi.fn(async () => ({ id: 'bac-1' })) },
      $queryRawUnsafe: vi.fn(async () => { throw new Error('raw SQL must not be used'); }),
      $executeRawUnsafe: vi.fn(async () => { throw new Error('raw SQL must not be used'); }),
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
    },
  };
});
vi.mock('../../../shared/database/prisma.js', () => ({ prisma: mocks.prisma, assertDatabaseReachable: vi.fn() }));

import { requestReturn, withdrawReturn } from '../return.service.js';

const { prisma, tx } = mocks;

const deliveredOrder = {
  id: 'ord-1',
  fulfilmentStatus: 'delivered',
  total: 20000,
  subtotal: 18000,
  currency: 'INR',
};

const line = {
  id: 'ol-1',
  orderId: 'ord-1',
  productId: 'p-1',
  variantId: 'v-1',
  quantity: 2,
  cancelledQty: 0,
  returnedQty: 0,
  deliveredAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
  returnWindowDays: null,
  unitPrice: 9000,
  lineTotal: 18000,
  nameEn: 'Kilim Rug',
};

const returnRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'ret-1',
  reference: 'RET-ABC123',
  orderId: 'ord-1',
  orderLineId: 'ol-1',
  variantId: 'v-1',
  requestedQty: 1,
  approvedQty: null,
  receivedQty: null,
  acceptedQty: null,
  restockQty: null,
  reason: 'damaged',
  customerNote: null,
  adminNote: null,
  rejectionReason: null,
  photos: '[]',
  status: 'requested',
  shippingMethod: null,
  customerCarrier: null,
  customerTracking: null,
  pickupAddress: null,
  returnCarrier: null,
  returnTracking: null,
  refundableAmount: 10000,
  shippingFee: 0,
  refundAmount: null,
  returnWindowDays: 30,
  refundAccountId: 'bac-1',
  refundMethodOverride: null,
  requestedAt: new Date(),
  decidedAt: null,
  receivedAt: null,
  inspectedAt: null,
  refundedAt: null,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(mocks.tx));
  mocks.prisma.order.findFirst.mockResolvedValue(deliveredOrder);
  mocks.prisma.orderLine.findUnique.mockResolvedValue(line);
  mocks.prisma.product.findUnique.mockResolvedValue({ returnsAllowed: true, returnDays: 30 });
  mocks.prisma.returnRequest.findUnique.mockResolvedValue(returnRow());
  mocks.prisma.returnRequest.findMany.mockResolvedValue([]);
  mocks.prisma.customerBankAccount.findFirst.mockResolvedValue({ id: 'bac-1' });
  mocks.tx.orderLine.findUnique.mockResolvedValue({ quantity: 2, cancelledQty: 0, returnedQty: 0 });
  mocks.tx.returnRequest.findMany.mockResolvedValue([]);
});

describe('requestReturn transaction (H15)', () => {
  const input = {
    orderId: 'ord-1',
    lineId: 'ol-1',
    qty: 1,
    reason: 'damaged' as const,
    note: 'Corner torn.',
    photos: [],
    refundAccountId: 'bac-1',
  };

  it('creates the request, reserves the quantity and logs the events in one transaction', async () => {
    await requestReturn('cust-1', input);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.returnRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orderId: 'ord-1',
          orderLineId: 'ol-1',
          requestedQty: 1,
          reason: 'damaged',
          refundableAmount: 10000,
          returnWindowDays: 30,
          // C9 trap: the refund account id goes through the Prisma model.
          refundAccountId: 'bac-1',
        }),
      }),
    );
    expect(tx.orderLine.update).toHaveBeenCalledWith({
      where: { id: 'ol-1' },
      data: { returnedQty: { increment: 1 } },
    });
    expect(tx.returnEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: 'requested', actor: 'customer' }) }),
    );
    expect(tx.orderEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: 'return', actor: 'customer' }) }),
    );
  });

  it('uses no raw SQL anywhere in the create path', async () => {
    await requestReturn('cust-1', input);
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('rejects a return outside the product window (30 days), measured from deliveredAt', async () => {
    mocks.prisma.orderLine.findUnique.mockResolvedValue({
      ...line,
      deliveredAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
    });

    await expect(requestReturn('cust-1', input)).rejects.toMatchObject({ code: 'conflict' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('withdrawReturn transaction (H15)', () => {
  it('withdraws and releases the reserved quantity in one transaction', async () => {
    mocks.prisma.returnRequest.findUnique.mockResolvedValue(returnRow({ status: 'requested' }));
    mocks.prisma.order.findFirst.mockResolvedValue({ id: 'ord-1' });
    mocks.tx.orderLine.findUnique.mockResolvedValue({ quantity: 2, cancelledQty: 0, returnedQty: 1 });

    const reference = await withdrawReturn('cust-1', 'RET-ABC123');

    expect(reference).toBe('RET-ABC123');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.returnRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'withdrawn' }) }),
    );
    expect(tx.orderLine.update).toHaveBeenCalledWith({
      where: { id: 'ol-1' },
      data: { returnedQty: 0 },
    });
    expect(tx.returnEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: 'withdrawn' }) }),
    );
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });
});
