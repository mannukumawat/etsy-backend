import { beforeEach, describe, expect, it, vi } from 'vitest';

// Unit tests for wallet top-up amount verification (H2): Prisma, the Razorpay payment
// fetch and the wallet ledger are mocked — no money moves and no gateway is called.

const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
  process.env.JWT_SECRET ??= 'test-only-jwt-secret-0123456789';
  const tx = {
    walletTopup: { update: vi.fn() },
  };
  return {
    tx,
    topupRow: {
      id: 'top_1',
      customerId: 'cust_1',
      amountPaise: 50000,
      razorpayOrderId: 'order_top1',
      razorpayPaymentId: null,
      status: 'pending',
    },
    prisma: {
      walletTopup: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn(async () => ({ count: 0 })) },
      walletBalance: { findUnique: vi.fn(async () => ({ balancePaise: 0 })) },
      walletTransaction: { findUnique: vi.fn(async () => null) },
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
    },
    fetchPayment: vi.fn(async () => ({ id: 'pay_1', amount: 50000, currency: 'INR', status: 'captured' })),
    verifySignature: vi.fn(),
    creditWallet: vi.fn(async () => ({ newBalance: 50000, txId: 'wtx1' })),
  };
});
vi.mock('../../../shared/database/prisma.js', () => ({ prisma: mocks.prisma, assertDatabaseReachable: vi.fn() }));
vi.mock('../../checkout/payment.service.js', () => ({
  createRazorpayOrder: vi.fn(),
  fetchRazorpayPayment: mocks.fetchPayment,
  verifyRazorpaySignature: mocks.verifySignature,
}));
vi.mock('../wallet.service.js', () => ({ creditWallet: mocks.creditWallet }));

import { handleTopupWebhook, markTopupFailed, verifyTopup } from '../wallet-topup.service.js';

const { prisma, topupRow, fetchPayment, creditWallet } = mocks;

beforeEach(() => {
  vi.clearAllMocks();
  topupRow.status = 'pending';
  prisma.walletTopup.findUnique.mockImplementation(async (args: { where: Record<string, string> }) => {
    if (args.where.id === 'top_1') return { ...topupRow };
    if (args.where.razorpayOrderId === 'order_top1') return { ...topupRow };
    return null;
  });
  prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(mocks.tx));
  fetchPayment.mockResolvedValue({ id: 'pay_1', amount: 50000, currency: 'INR', status: 'captured' });
  creditWallet.mockResolvedValue({ newBalance: 50000, txId: 'wtx1' });
});

const verifyInput = { topupId: 'top_1', razorpayPaymentId: 'pay_1', razorpaySignature: 'sig' };

describe('verifyTopup — amount verification (H2)', () => {
  it('credits the wallet when the captured payment matches the top-up amount', async () => {
    const result = await verifyTopup('cust_1', verifyInput);
    expect(result).toEqual({ alreadyCredited: false, balancePaise: 50000 });
    expect(fetchPayment).toHaveBeenCalledWith('pay_1');
    expect(creditWallet).toHaveBeenCalledWith('cust_1', 50000, 'topup', 'topup:top_1', expect.anything());
  });

  it('refuses to credit when the captured amount differs', async () => {
    fetchPayment.mockResolvedValue({ id: 'pay_1', amount: 10000, currency: 'INR', status: 'captured' });
    await expect(verifyTopup('cust_1', verifyInput)).rejects.toThrow('amount does not match');
    expect(creditWallet).not.toHaveBeenCalled();
  });

  it('refuses to credit when the payment was not captured', async () => {
    fetchPayment.mockResolvedValue({ id: 'pay_1', amount: 50000, currency: 'INR', status: 'authorized' });
    await expect(verifyTopup('cust_1', verifyInput)).rejects.toThrow('not captured');
    expect(creditWallet).not.toHaveBeenCalled();
  });

  it('refuses to credit a top-up already marked failed (the failed guard is reachable)', async () => {
    topupRow.status = 'failed';
    await expect(verifyTopup('cust_1', verifyInput)).rejects.toThrow('marked as failed');
    expect(fetchPayment).not.toHaveBeenCalled();
    expect(creditWallet).not.toHaveBeenCalled();
  });
});

describe('markTopupFailed (H2)', () => {
  it('marks a pending top-up failed', async () => {
    prisma.walletTopup.updateMany.mockResolvedValue({ count: 1 });
    await expect(markTopupFailed('order_top1', 'pay_1')).resolves.toEqual({ status: 'failed' });
    expect(prisma.walletTopup.updateMany).toHaveBeenCalledWith({
      where: { razorpayOrderId: 'order_top1', status: 'pending' },
      data: { status: 'failed', razorpayPaymentId: 'pay_1' },
    });
  });

  it('never fails an already-paid top-up', async () => {
    prisma.walletTopup.updateMany.mockResolvedValue({ count: 0 });
    prisma.walletTopup.findUnique.mockResolvedValue({ ...topupRow, status: 'paid' });
    await expect(markTopupFailed('order_top1', 'pay_1')).resolves.toEqual({ status: 'already_credited' });
  });

  it('reports an unknown Razorpay order', async () => {
    prisma.walletTopup.updateMany.mockResolvedValue({ count: 0 });
    prisma.walletTopup.findUnique.mockResolvedValue(null);
    await expect(markTopupFailed('order_nope')).resolves.toEqual({ status: 'unknown_order' });
  });
});

describe('handleTopupWebhook — amount verification (H2)', () => {
  it('credits the wallet when the webhook payment matches', async () => {
    const result = await handleTopupWebhook('order_top1', 'pay_1');
    expect(result).toEqual({ status: 'credited', newBalance: 50000 });
    expect(creditWallet).toHaveBeenCalled();
  });

  it('does not credit when the webhook payment amount differs', async () => {
    fetchPayment.mockResolvedValue({ id: 'pay_1', amount: 49999, currency: 'INR', status: 'captured' });
    await expect(handleTopupWebhook('order_top1', 'pay_1')).rejects.toThrow('amount does not match');
    expect(creditWallet).not.toHaveBeenCalled();
  });

  it('does not credit a failed top-up', async () => {
    topupRow.status = 'failed';
    const result = await handleTopupWebhook('order_top1', 'pay_1');
    expect(result).toEqual({ status: 'failed' });
    expect(creditWallet).not.toHaveBeenCalled();
  });
});
