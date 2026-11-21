import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';

// Unit tests for captured-payment verification (H3): the gateway is injected, so no
// Razorpay credentials or network are needed. Fail-closed behaviour is tested by
// injecting `gateway: null`.

import { fetchRazorpayPayment, verifyCapturedPayment, verifyRazorpayOrderAmount, verifyRazorpaySignature, type RazorpayGatewayLike } from '../payment.service.js';

describe('verifyRazorpaySignature (M1, timing-safe)', () => {
  const secret = process.env.RAZORPAY_KEY_SECRET ?? '';
  const good = (orderId = 'order_1', paymentId = 'pay_1') =>
    crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');

  it('accepts the genuine signature', () => {
    expect(() => verifyRazorpaySignature('order_1', 'pay_1', good())).not.toThrow();
  });

  it('rejects a tampered signature, a wrong-length signature, and a signature for another payment', () => {
    expect(() => verifyRazorpaySignature('order_1', 'pay_1', 'deadbeef')).toThrow('Payment verification failed');
    expect(() => verifyRazorpaySignature('order_1', 'pay_1', good().slice(0, 32))).toThrow('Payment verification failed');
    expect(() => verifyRazorpaySignature('order_1', 'pay_1', good('order_1', 'pay_2'))).toThrow('Payment verification failed');
    expect(() => verifyRazorpaySignature('order_1', 'pay_1', '')).toThrow('Payment verification failed');
  });
});

const gateway = (over: Partial<{ orderAmount: number; orderCurrency: string; payAmount: number; payCurrency: string; payStatus: string }> = {}): RazorpayGatewayLike => ({
  orders: {
    fetch: async (id: string) => ({ id, amount: over.orderAmount ?? 20000, currency: over.orderCurrency ?? 'INR' }),
  },
  payments: {
    fetch: async (id: string) => ({
      id,
      amount: over.payAmount ?? 20000,
      currency: over.payCurrency ?? 'INR',
      status: over.payStatus ?? 'captured',
    }),
  },
});

describe('verifyCapturedPayment (H3)', () => {
  it('accepts a captured payment for the exact remainder amount and currency', async () => {
    await expect(verifyCapturedPayment('pay_1', 20000, 'INR', { gateway: gateway() })).resolves.toBeUndefined();
  });

  it('rejects a payment that was not captured', async () => {
    await expect(verifyCapturedPayment('pay_1', 20000, 'INR', { gateway: gateway({ payStatus: 'authorized' }) })).rejects.toThrow('not captured');
    await expect(verifyCapturedPayment('pay_1', 20000, 'INR', { gateway: gateway({ payStatus: 'failed' }) })).rejects.toThrow('not captured');
  });

  it('rejects amount and currency mismatches against the expected remainder', async () => {
    await expect(verifyCapturedPayment('pay_1', 19999, 'INR', { gateway: gateway() })).rejects.toThrow('amount mismatch');
    await expect(verifyCapturedPayment('pay_1', 20000, 'USD', { gateway: gateway() })).rejects.toThrow('currency mismatch');
  });

  it('fails closed when the gateway is not configured', async () => {
    await expect(verifyCapturedPayment('pay_1', 20000, 'INR', { gateway: null })).rejects.toThrow('Payment gateway not configured');
    await expect(fetchRazorpayPayment('pay_1', { gateway: null })).rejects.toThrow('Payment gateway not configured');
  });

  it('a payment lookup failure is a 400, not a silent pass', async () => {
    const failing: RazorpayGatewayLike = {
      orders: { fetch: async () => { throw new Error('nope'); } },
      payments: { fetch: async () => { throw new Error('nope'); } },
    };
    await expect(verifyCapturedPayment('pay_1', 20000, 'INR', { gateway: failing })).rejects.toThrow('Could not verify payment');
  });
});

describe('verifyRazorpayOrderAmount (H3, fail-closed)', () => {
  it('accepts a matching order amount and currency', async () => {
    await expect(verifyRazorpayOrderAmount('order_1', 20000, 'INR', { gateway: gateway() })).resolves.toBeUndefined();
  });

  it('rejects amount and currency mismatches', async () => {
    await expect(verifyRazorpayOrderAmount('order_1', 19999, 'INR', { gateway: gateway() })).rejects.toThrow('amount mismatch');
    await expect(verifyRazorpayOrderAmount('order_1', 20000, 'EUR', { gateway: gateway() })).rejects.toThrow('currency mismatch');
  });

  it('fails closed when the gateway is not configured (no more silent skip)', async () => {
    await expect(verifyRazorpayOrderAmount('order_1', 20000, 'INR', { gateway: null })).rejects.toThrow('Payment gateway not configured');
  });
});
