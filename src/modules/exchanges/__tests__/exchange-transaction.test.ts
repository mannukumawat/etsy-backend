import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hermetic tests for the exchange create / withdraw transactions (H15) and the
// converted price difference (H16): Prisma is mocked, no database is touched,
// and the raw-SQL methods throw if called.
const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'mysql://user:pass@localhost:3306/testdb';
  process.env.JWT_SECRET ??= 'test-only-jwt-secret-0123456789';
  const tx = {
    orderLine: {
      findUnique: vi.fn(async () => ({ quantity: 1, cancelledQty: 0, returnedQty: 0, exchangedQty: 0 })),
      update: vi.fn(),
    },
    exchangeRequest: { findMany: vi.fn(async () => []), create: vi.fn(), update: vi.fn() },
    exchangeEvent: { create: vi.fn() },
    orderEvent: { create: vi.fn() },
  };
  return {
    tx,
    prisma: {
      order: { findFirst: vi.fn(), findMany: vi.fn(async () => []) },
      orderLine: { findUnique: vi.fn() },
      orderEvent: { findFirst: vi.fn(async () => null) },
      product: { findUnique: vi.fn() },
      productVariant: { findUnique: vi.fn() },
      currencyConfig: { findFirst: vi.fn(async () => ({ fractionDigits: 2, roundingIncrement: 100 })) },
      exchangeRequest: { findUnique: vi.fn(), findMany: vi.fn(async () => []) },
      exchangeEvent: { findMany: vi.fn(async () => []), create: vi.fn() },
      $queryRawUnsafe: vi.fn(async () => { throw new Error('raw SQL must not be used'); }),
      $executeRawUnsafe: vi.fn(async () => { throw new Error('raw SQL must not be used'); }),
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
    },
  };
});
vi.mock('../../../shared/database/prisma.js', () => ({ prisma: mocks.prisma, assertDatabaseReachable: vi.fn() }));

import { requestExchange, withdrawExchange } from '../exchange.service.js';

const { prisma, tx } = mocks;

const INR_SNAPSHOT = JSON.stringify({ base: 'USD', rates: { USD: 1, INR: 84 }, asOf: '2026-11-20T00:00:00.000Z' });

const deliveredOrder = {
  id: 'ord-1',
  fulfilmentStatus: 'delivered',
  currency: 'INR',
  rateSnapshotJson: INR_SNAPSHOT,
};

const line = {
  id: 'ol-1',
  orderId: 'ord-1',
  productId: 'p-1',
  variantId: 'v-orig',
  quantity: 1,
  cancelledQty: 0,
  returnedQty: 0,
  exchangedQty: 0,
  deliveredAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
  returnWindowDays: null,
  unitPrice: 840000,
  nameEn: 'Kilim Rug',
};

const exchangeRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'ex-1',
  reference: 'EXC-ABC123',
  orderId: 'ord-1',
  orderLineId: 'ol-1',
  originalVariantId: 'v-orig',
  replacementVariantId: 'v-repl',
  requestedQty: 1,
  approvedQty: null,
  reason: 'wrong_size',
  customerNote: null,
  adminNote: null,
  rejectionReason: null,
  status: 'requested',
  priceDifference: 168000,
  exchangeWindowDays: 30,
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
  mocks.prisma.order.findFirst.mockResolvedValue(deliveredOrder);
  mocks.prisma.orderLine.findUnique.mockResolvedValue(line);
  mocks.prisma.product.findUnique.mockResolvedValue({ exchangeAllowed: true, returnDays: 30 });
  mocks.prisma.productVariant.findUnique.mockResolvedValue({ price: 10000, salePrice: 12000, stock: 5, productId: 'p-1' });
  mocks.prisma.currencyConfig.findFirst.mockResolvedValue({ fractionDigits: 2, roundingIncrement: 100 });
  mocks.prisma.exchangeRequest.findUnique.mockResolvedValue(exchangeRow());
  mocks.prisma.exchangeRequest.findMany.mockResolvedValue([]);
  mocks.tx.orderLine.findUnique.mockResolvedValue({ quantity: 1, cancelledQty: 0, returnedQty: 0, exchangedQty: 0 });
  mocks.tx.exchangeRequest.findMany.mockResolvedValue([]);
});

describe('requestExchange transaction (H15 + H16)', () => {
  const input = {
    orderId: 'ord-1',
    lineId: 'ol-1',
    qty: 1,
    reason: 'wrong_size' as const,
    replacementVariantId: 'v-repl',
  };

  it('creates the request with the converted price difference in one transaction', async () => {
    await requestExchange('cust-1', input);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.exchangeRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orderId: 'ord-1',
          orderLineId: 'ol-1',
          requestedQty: 1,
          // $120 replacement -> 1,008,000 paise; line $100 -> 840,000 paise.
          priceDifference: 168000,
          exchangeWindowDays: 30,
        }),
      }),
    );
    expect(tx.orderLine.update).toHaveBeenCalledWith({
      where: { id: 'ol-1' },
      data: { exchangedQty: { increment: 1 } },
    });
    expect(tx.exchangeEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: 'requested', actor: 'customer' }) }),
    );
  });

  it('uses no raw SQL anywhere in the create path', async () => {
    await requestExchange('cust-1', input);
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('rejects an exchange outside the product window (30 days), measured from deliveredAt', async () => {
    mocks.prisma.orderLine.findUnique.mockResolvedValue({
      ...line,
      deliveredAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
    });

    await expect(requestExchange('cust-1', input)).rejects.toMatchObject({ code: 'conflict' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('withdrawExchange transaction (H15)', () => {
  it('withdraws and releases the reserved quantity in one transaction', async () => {
    mocks.prisma.exchangeRequest.findUnique.mockResolvedValue(exchangeRow({ status: 'requested' }));
    mocks.prisma.order.findFirst.mockResolvedValue({ id: 'ord-1' });
    mocks.tx.orderLine.findUnique.mockResolvedValue({ quantity: 1, cancelledQty: 0, returnedQty: 0, exchangedQty: 1 });

    const reference = await withdrawExchange('cust-1', 'EXC-ABC123');

    expect(reference).toBe('EXC-ABC123');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.exchangeRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'withdrawn' }) }),
    );
    expect(tx.orderLine.update).toHaveBeenCalledWith({
      where: { id: 'ol-1' },
      data: { exchangedQty: 0 },
    });
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });
});
