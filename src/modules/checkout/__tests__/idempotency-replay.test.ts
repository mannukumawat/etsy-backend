import { describe, expect, it } from 'vitest';

// Pure unit tests for the idempotent-replay guards (H1): no database, no gateway.

import {
  isCouponRedemptionClash,
  isIdempotencyKeyClash,
  isOrderNumberClash,
  isPaymentReferenceClash,
  replayOwnershipMatches,
  replayPayloadMatches,
  type ReplayOrderLike,
  type ReplayRequestLike,
} from '../idempotency.js';

const order = (over: Partial<ReplayOrderLike> = {}): ReplayOrderLike => ({
  customerId: 'cust_1',
  customerEmail: 'buyer@example.com',
  currency: 'INR',
  total: 20000,
  paymentReference: 'pay_123',
  lines: [
    { variantId: 'v1', quantity: 2 },
    { variantId: 'v2', quantity: 1 },
  ],
  ...over,
});

const request = (over: Partial<ReplayRequestLike> = {}): ReplayRequestLike => ({
  customerId: 'cust_1',
  email: 'buyer@example.com',
  currency: 'INR',
  lines: [
    { variantId: 'v2', quantity: 1 },
    { variantId: 'v1', quantity: 2 },
  ],
  total: 20000,
  razorpayPaymentId: 'pay_123',
  ...over,
});

describe('replayOwnershipMatches (H1c)', () => {
  it('a signed-in requester must own the order', () => {
    expect(replayOwnershipMatches(order(), 'cust_1', 'buyer@example.com')).toBe(true);
    expect(replayOwnershipMatches(order(), 'cust_2', 'buyer@example.com')).toBe(false);
  });

  it('a guest requester must match the order email and the order must be a guest order', () => {
    const guestOrder = order({ customerId: null });
    expect(replayOwnershipMatches(guestOrder, null, 'buyer@example.com')).toBe(true);
    expect(replayOwnershipMatches(guestOrder, null, 'BUYER@example.com')).toBe(true); // case-insensitive
    expect(replayOwnershipMatches(guestOrder, null, 'other@example.com')).toBe(false);
    expect(replayOwnershipMatches(order(), null, 'buyer@example.com')).toBe(false); // account order, guest replay
  });
});

describe('replayPayloadMatches (H1c)', () => {
  it('matches the same cart regardless of line order', () => {
    expect(replayPayloadMatches(order(), request())).toBe(true);
  });

  it('rejects a different currency, total, or set of lines', () => {
    expect(replayPayloadMatches(order(), request({ currency: 'USD' }))).toBe(false);
    expect(replayPayloadMatches(order(), request({ total: 19999 }))).toBe(false);
    expect(replayPayloadMatches(order(), request({ lines: [{ variantId: 'v1', quantity: 2 }] }))).toBe(false);
    expect(replayPayloadMatches(order(), request({ lines: [{ variantId: 'v1', quantity: 1 }, { variantId: 'v2', quantity: 1 }] }))).toBe(false);
  });

  it('rejects a different Razorpay payment id, but allows a retry that lost the payment fields', () => {
    expect(replayPayloadMatches(order(), request({ razorpayPaymentId: 'pay_other' }))).toBe(false);
    expect(replayPayloadMatches(order(), request({ razorpayPaymentId: undefined }))).toBe(true);
    expect(replayPayloadMatches(order({ paymentReference: null }), request({ razorpayPaymentId: 'pay_123' }))).toBe(false);
  });

  it('the total is only checked once it is known (pre-compute replay omits it)', () => {
    const { total: _total, ...withoutTotal } = request();
    expect(replayPayloadMatches(order(), withoutTotal)).toBe(true);
  });
});

describe('Prisma unique-violation classifiers', () => {
  const p2002 = (target: string) => ({ code: 'P2002', meta: { target } });

  it('classifies order-number, idempotency-key, payment-reference and coupon clashes', () => {
    expect(isOrderNumberClash(p2002('orders_number_key'))).toBe(true);
    expect(isIdempotencyKeyClash(p2002('orders_idempotencyKey_key'))).toBe(true);
    expect(isPaymentReferenceClash(p2002('orders_paymentReference_key'))).toBe(true);
    expect(isCouponRedemptionClash(p2002('CouponRedemption_couponId_customerKey_key'))).toBe(true);
  });

  it('does not misclassify other errors', () => {
    expect(isPaymentReferenceClash(p2002('orders_idempotencyKey_key'))).toBe(false);
    expect(isCouponRedemptionClash(p2002('orders_number_key'))).toBe(false);
    expect(isCouponRedemptionClash({ code: 'P2002', meta: { target: 'CouponRedemption_couponId_key' } })).toBe(false);
    expect(isIdempotencyKeyClash({ code: 'P2025' })).toBe(false);
    expect(isIdempotencyKeyClash(new Error('boom'))).toBe(false);
  });
});
