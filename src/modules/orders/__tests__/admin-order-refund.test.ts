import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Route-level regression tests for real refunds (C7): Prisma + Razorpay are mocked,
// the owner session + CSRF are real, so the HTTP contract is exercised end to end.

const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
  process.env.JWT_SECRET ??= 'test-only-jwt-secret-0123456789';
  const table = new Map<string, Record<string, unknown>>();
  const refundModel = {
    create: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
  };
  const tx = {
    order: { updateMany: vi.fn(async (..._args: unknown[]) => ({ count: 1 })) },
    orderEvent: { create: vi.fn() },
    refund: refundModel,
  };
  const orderRow = {
    id: 'ord_1',
    number: 'YS-1001',
    customerId: 'cust_1',
    customerEmail: 'buyer@example.com',
    customerName: 'Test Buyer',
    customerPhone: null,
    currency: 'INR',
    subtotal: 19000,
    shippingTotal: 1000,
    taxTotal: 0,
    discountTotal: 0,
    total: 20000,
    refundedTotal: 0,
    paymentStatus: 'paid',
    paymentMethod: 'card',
    paymentReference: 'pay_test123',
    fulfilmentStatus: 'unfulfilled',
    restocked: false,
    carrier: null,
    trackingNumber: null,
    trackingUrl: null,
    couponCode: null,
    taxRate: 0,
    taxInclusive: false,
    shippingMaxDays: null,
    shippingAddressJson: JSON.stringify({ name: 'Test', line1: '1 Main St', city: 'Jaipur', country: 'IN', postalCode: '302001' }),
    rateSnapshotJson: JSON.stringify({ base: 'USD', rates: { INR: 84 }, asOf: '2026-11-20' }),
    createdAt: new Date('2026-11-20T09:00:00.000Z'),
    updatedAt: new Date('2026-11-20T09:00:00.000Z'),
    lines: [],
    events: [],
    notes: [],
  };
  return {
    table,
    tx,
    refundModel,
    orderRow,
    prisma: {
      owner: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn(), create: vi.fn() },
      order: { findUnique: vi.fn(), updateMany: vi.fn(async () => ({ count: 1 })) },
      refund: refundModel,
      revokedSession: { findUnique: vi.fn(async () => null), upsert: vi.fn(async () => ({})), deleteMany: vi.fn(async () => ({ count: 0 })) },
      $queryRawUnsafe: vi.fn(),
      $executeRawUnsafe: vi.fn(),
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
    },
    gatewayRefund: vi.fn(async () => ({ id: 'rfnd_test123', status: 'processed' })),
    isRazorpayConfigured: vi.fn(() => true),
    creditWallet: vi.fn(async () => ({ newBalance: 5000, txId: 'wtx1' })),
  };
});
vi.mock('../../../shared/database/prisma.js', () => ({ prisma: mocks.prisma, assertDatabaseReachable: vi.fn() }));
vi.mock('@prisma/client', () => ({
  PrismaClient: class {},
  Prisma: { PrismaClientKnownRequestError: class extends Error { code?: string } },
}));
vi.mock('../../checkout/payment.service.js', () => ({
  isRazorpayConfigured: mocks.isRazorpayConfigured,
  refundRazorpayPayment: mocks.gatewayRefund,
}));
vi.mock('../../wallet/wallet.service.js', () => ({ creditWallet: mocks.creditWallet }));

import { createApp } from '../../../app.js';
import { findOwner, loginAsOwner, type Session } from '../../../__tests__/support/owner-session.js';

const { prisma, table, tx, orderRow, gatewayRefund } = mocks;
const app = createApp();
let session: Session;
let totals = { refundedTotal: 0, paymentStatus: 'paid' };

function wireFakeRefunds() {
  const { refundModel } = mocks;
  // Unrelated raw reads (line extras) return empty rows, as before.
  prisma.$queryRawUnsafe.mockImplementation(async () => []);
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

beforeAll(async () => {
  vi.stubEnv('OWNER_EMAIL', '');
  vi.stubEnv('OWNER_PASSWORD', '');
  prisma.owner.findUnique.mockImplementation(findOwner);
  session = await loginAsOwner(app);
});

beforeEach(() => {
  vi.clearAllMocks();
  table.clear();
  totals = { refundedTotal: 0, paymentStatus: 'paid' };
  prisma.owner.findUnique.mockImplementation(findOwner);
  prisma.order.findUnique.mockImplementation(async () => ({ ...orderRow, ...totals }));
  prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx));
  tx.order.updateMany.mockImplementation(async (args: any) => {
    totals = { refundedTotal: args.data.refundedTotal, paymentStatus: args.data.paymentStatus };
    return { count: 1 };
  });
  mocks.isRazorpayConfigured.mockReturnValue(true);
  wireFakeRefunds();
});

const auth = (req: request.Test) => req.set('Cookie', session.cookie).set('x-csrf-token', session.csrf);

describe('POST /api/admin/orders/:id/refund', () => {
  it('issues a real Razorpay refund and returns the order with the completed refund', async () => {
    const res = await auth(request(app).post('/api/admin/orders/ord_1/refund')).send({
      amount: 20000, reason: 'Damaged item', method: 'original',
    });
    expect(res.status).toBe(200);
    expect(res.body.payment.status).toBe('refunded');
    expect(res.body.refundedTotal).toBe(20000);
    expect(res.body.refunds).toHaveLength(1);
    expect(res.body.refunds[0]).toMatchObject({ status: 'completed', reference: 'rfnd_test123', method: 'original' });
    expect(gatewayRefund).toHaveBeenCalledWith('pay_test123', 20000, expect.anything());
  });

  it('rejects an over-refund with 400 and never calls the gateway', async () => {
    const res = await auth(request(app).post('/api/admin/orders/ord_1/refund')).send({
      amount: 20001, reason: 'Too much', method: 'original',
    });
    expect(res.status).toBe(400);
    expect(gatewayRefund).not.toHaveBeenCalled();
  });

  it('records a manual refund as pending and verifies it through the verify endpoint', async () => {
    const res = await auth(request(app).post('/api/admin/orders/ord_1/refund')).send({
      amount: 8000, reason: 'Bank transfer', method: 'manual_bank', reference: 'UTR123456',
    });
    expect(res.status).toBe(200);
    expect(res.body.refunds[0]).toMatchObject({ status: 'pending', reference: 'UTR123456' });
    expect(res.body.payment.status).toBe('paid'); // totals do not move until verified

    const refundId = res.body.refunds[0].id as string;
    const verified = await auth(request(app).post(`/api/admin/orders/ord_1/refunds/${refundId}/verify`)).send({});
    expect(verified.status).toBe(200);
    expect(verified.body.refunds[0]).toMatchObject({ status: 'completed' });
    expect(verified.body.refundedTotal).toBe(8000);
  });

  it('rejects a manual refund without a reference', async () => {
    const res = await auth(request(app).post('/api/admin/orders/ord_1/refund')).send({
      amount: 8000, reason: 'Bank transfer', method: 'manual_bank',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/reference/i);
  });

  it('requires an owner session (401) and a CSRF token (403)', async () => {
    const noAuth = await request(app).post('/api/admin/orders/ord_1/refund').send({ amount: 100, reason: 'x' });
    expect(noAuth.status).toBe(401);
    const noCsrf = await request(app).post('/api/admin/orders/ord_1/refund').set('Cookie', session.cookie).send({ amount: 100, reason: 'x' });
    expect(noCsrf.status).toBe(403);
  });
});
