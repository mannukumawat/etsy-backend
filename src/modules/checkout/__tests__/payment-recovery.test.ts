import crypto from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hermetic tests for the order-payment webhook reconciliation (H5): Prisma is mocked,
// no database or Razorpay call happens. The webhook secret is set before the env
// module loads, so the HMAC check runs for real.
const WEBHOOK_SECRET = 'whsec_test_only_secret';

const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'mysql://user:pass@localhost:3306/testdb';
  process.env.JWT_SECRET ??= 'test-only-jwt-secret-0123456789';
  process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec_test_only_secret';
  return {
    prisma: {
      order: { findFirst: vi.fn() },
      walletTopup: { findFirst: vi.fn() },
      $executeRawUnsafe: vi.fn(),
      $queryRawUnsafe: vi.fn(),
    },
  };
});
vi.mock('../../../shared/database/prisma.js', () => ({ prisma: mocks.prisma, assertDatabaseReachable: vi.fn() }));

import { verifyRazorpayWebhookSignature } from '../../../shared/utils/webhook.js';
import { recordCapturedPayment } from '../payment-recovery.service.js';

const { prisma } = mocks;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('verifyRazorpayWebhookSignature (H5)', () => {
  it('accepts the HMAC Razorpay sends and rejects anything else (or no secret)', () => {
    const body = Buffer.from(JSON.stringify({ event: 'payment.captured' }), 'utf8');
    const good = crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
    expect(verifyRazorpayWebhookSignature(body, good)).toBe(true);
    expect(verifyRazorpayWebhookSignature(body, 'deadbeef')).toBe(false);
    expect(verifyRazorpayWebhookSignature(body, '')).toBe(false);
    expect(verifyRazorpayWebhookSignature(Buffer.from('tampered'), good)).toBe(false);
  });
});

describe('recordCapturedPayment (H5)', () => {
  const payment = { razorpayPaymentId: 'pay_123', razorpayOrderId: 'order_456', amount: 1573900, currency: 'INR', customerEmail: 'a@example.com' };

  it('matches a payment that already belongs to an order (no recovery row)', async () => {
    prisma.order.findFirst.mockResolvedValue({ id: 'o1', number: 'YS-240501' });

    const result = await recordCapturedPayment(payment);

    expect(result).toEqual({ matched: true, recoveryId: null, orderNumber: 'YS-240501' });
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('matches a wallet top-up payment (owned by the wallet webhook)', async () => {
    prisma.order.findFirst.mockResolvedValue(null);
    prisma.walletTopup.findFirst.mockResolvedValue({ id: 't1' });

    const result = await recordCapturedPayment(payment);

    expect(result).toEqual({ matched: true, recoveryId: null });
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('records an unmatched payment for the owner to resolve', async () => {
    prisma.order.findFirst.mockResolvedValue(null);
    prisma.walletTopup.findFirst.mockResolvedValue(null);
    prisma.$queryRawUnsafe.mockResolvedValue([{ id: 'rec_1' }]);

    const result = await recordCapturedPayment(payment);

    expect(result).toEqual({ matched: false, recoveryId: 'rec_1' });
    const sql = String(prisma.$executeRawUnsafe.mock.calls[0][0]);
    expect(sql).toContain('INSERT INTO payment_recoveries');
    expect(sql).toContain('ON DUPLICATE KEY UPDATE');
    const args = prisma.$executeRawUnsafe.mock.calls[0];
    expect(args[2]).toBe('pay_123');
    expect(args[3]).toBe('order_456');
    expect(args[4]).toBe(1573900);
    expect(args[5]).toBe('INR');
  });
});
