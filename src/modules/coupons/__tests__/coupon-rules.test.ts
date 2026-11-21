import { describe, expect, it } from 'vitest';
import { evaluateCoupon, type CouponLike } from '../coupon-rules.service.js';

// Pure helper: no database, no network. Covers the L3 rounding route — the
// percentage-discount path must round through the currency's rounding increment
// (roundMinor), like every other converted amount.

const USD = { code: 'USD', rate: 1, fractionDigits: 2, roundingIncrement: 1 };
const INR = { code: 'INR', rate: 84, fractionDigits: 0, roundingIncrement: 100 };

const baseCoupon: CouponLike = {
  type: 'percentage',
  value: 10,
  maxDiscount: null,
  minOrder: null,
  startsAt: null,
  endsAt: null,
  isActive: true,
  usageLimit: null,
  perCustomerLimit: null,
  timesUsed: 0,
  scope: 'all',
  productIds: '[]',
  categoryIds: '[]',
};

const lines = [{ productId: 'p1', categoryId: 'c1', lineTotal: 100050 }];

describe('evaluateCoupon percentage rounding (L3)', () => {
  it('rounds the discount to the currency increment (INR: nearest rupee)', () => {
    // 10% of 100,050 paise is 10,005 paise; roundMinor with increment 100 gives 10,000.
    const result = evaluateCoupon(baseCoupon, lines, INR, new Date(), 0);
    expect(result).toEqual({ ok: true, discount: 10000 });
  });

  it('rounds exactly with cent-precision currencies (USD increment 1)', () => {
    const result = evaluateCoupon(baseCoupon, lines, USD, new Date(), 0);
    expect(result).toEqual({ ok: true, discount: 10005 });
  });

  it('still caps the discount at maxDiscount', () => {
    const capped = evaluateCoupon({ ...baseCoupon, maxDiscount: 5000 }, lines, USD, new Date(), 0);
    expect(capped.discount).toBe(5000);
  });
});
