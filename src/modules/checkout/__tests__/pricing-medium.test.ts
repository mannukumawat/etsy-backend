import { describe, expect, it } from 'vitest';
import { convertFromBase } from '../../../shared/utils/currency.js';
import { isIdempotencyKeyClash, isOrderNumberClash } from '../idempotency.js';
import { calculateTotals, getShippingQuotes, getTaxRate } from '../pricing.service.js';

// Pure helpers: no database, no network. Covers the Medium findings M-S2 (free-shipping
// threshold), M-S3 (missing/zero-rate guard) and M-I6 (idempotency clash classification).

const USD = { code: 'USD', rate: 1, fractionDigits: 2, roundingIncrement: 1 };
const INR = { code: 'INR', rate: 84, fractionDigits: 0, roundingIncrement: 100 };

const ZONES = [
  {
    id: 'z1',
    nameEn: 'Test zone',
    countries: JSON.stringify(['IN', 'US']),
    standardEnabled: true,
    standardRate: 500,
    standardMinDays: 3,
    standardMaxDays: 5,
    expressEnabled: true,
    expressRate: 1500,
    expressMinDays: 1,
    expressMaxDays: 2,
  },
];

describe('getShippingQuotes free-shipping threshold (M-S2)', () => {
  it('charges the zone rate when there is no threshold', () => {
    const quotes = getShippingQuotes(ZONES, 'IN', USD);
    expect(quotes.find((q) => q.id === 'standard')?.amount).toBe(500);
    expect(quotes.find((q) => q.id === 'express')?.amount).toBe(1500);
  });

  it('charges 0 for every method once the subtotal reaches the threshold', () => {
    const quotes = getShippingQuotes(ZONES, 'IN', USD, { thresholdMinor: 10000, subtotalMinor: 10000 });
    expect(quotes.every((q) => q.amount === 0)).toBe(true);
  });

  it('still charges below the threshold', () => {
    const quotes = getShippingQuotes(ZONES, 'IN', USD, { thresholdMinor: 10000, subtotalMinor: 9999 });
    expect(quotes.find((q) => q.id === 'standard')?.amount).toBe(500);
  });

  it('converts the USD threshold into the shopper currency before comparing', () => {
    // $100 threshold = 10,000 USD minor → 840,000 paise at rate 84; a ₹9,000 subtotal
    // (900,000 paise) clears it, a ₹8,000 subtotal (800,000 paise) does not.
    const free = getShippingQuotes(ZONES, 'IN', INR, { thresholdMinor: 840000, subtotalMinor: 900000 });
    expect(free.every((q) => q.amount === 0)).toBe(true);
    const paid = getShippingQuotes(ZONES, 'IN', INR, { thresholdMinor: 840000, subtotalMinor: 800000 });
    expect(paid.find((q) => q.id === 'standard')?.amount).toBeGreaterThan(0);
  });

  it('returns no quotes for an unzoned destination even with a threshold', () => {
    expect(getShippingQuotes(ZONES, 'BR', USD, { thresholdMinor: 1, subtotalMinor: 99999 })).toEqual([]);
  });
});

describe('convertFromBase rate guard (M-S3)', () => {
  it('converts normally with a valid rate', () => {
    expect(convertFromBase(1000, INR)).toBe(84000);
  });

  it('throws instead of returning NaN or 0 for a missing/zero/negative rate', () => {
    expect(() => convertFromBase(1000, { ...INR, rate: 0 })).toThrow(/exchange rate/i);
    expect(() => convertFromBase(1000, { ...INR, rate: Number.NaN })).toThrow(/exchange rate/i);
    expect(() => convertFromBase(1000, { ...INR, rate: -5 })).toThrow(/exchange rate/i);
  });
});

describe('idempotency clash classifiers (M-I6)', () => {
  it('recognises an order-number unique violation', () => {
    expect(isOrderNumberClash({ code: 'P2002', meta: { target: ['orders_number_key'] } })).toBe(true);
    expect(isOrderNumberClash({ code: 'P2002', meta: { target: ['orders_idempotencyKey_key'] } })).toBe(false);
    expect(isOrderNumberClash({ code: 'P2003' })).toBe(false);
  });

  it('recognises an idempotency-key unique violation as a replay', () => {
    expect(isIdempotencyKeyClash({ code: 'P2002', meta: { target: 'orders_idempotencyKey_key' } })).toBe(true);
    expect(isIdempotencyKeyClash({ code: 'P2002', meta: { target: ['orders_number_key'] } })).toBe(false);
    expect(isIdempotencyKeyClash(new Error('boom'))).toBe(false);
  });
});

describe('getTaxRate region matching (L-S4)', () => {  const rules = [
    { country: 'US', region: 'California', rate: 7.25 },
    { country: 'US', region: '', rate: 5 },
    { country: 'IN', region: 'Rajasthan', rate: 12 },
  ];
  it('matches regions case-insensitively, exactly like the admin preview', () => {
    expect(getTaxRate(rules, 0, 'US', 'california')).toBe(7.25);
    expect(getTaxRate(rules, 0, 'US', 'CALIFORNIA')).toBe(7.25);
    expect(getTaxRate(rules, 0, 'US', '  California  ')).toBe(7.25);
    expect(getTaxRate(rules, 0, 'IN', 'rajasthan')).toBe(12);
  });
  it('falls back to the country rule, then the default rate', () => {
    expect(getTaxRate(rules, 0, 'US', 'Texas')).toBe(5);
    expect(getTaxRate(rules, 0, 'US', null)).toBe(5);
    expect(getTaxRate(rules, 0, 'DE', 'Bavaria')).toBe(0);
    expect(getTaxRate(rules, 3, 'DE', undefined)).toBe(3);
  });
});

describe('calculateTotals tax rounding (L3)', () => {
  const base = { lineTotals: [100050], discount: 0, shipping: 0, taxRate: 10, taxInclusive: false };
  it('rounds tax to the currency increment when one is passed (INR: nearest rupee)', () => {
    // 10% of 100,050 paise is 10,005 paise; increment 100 rounds it to 10,000.
    const totals = calculateTotals({ ...base, roundingIncrement: 100 });
    expect(totals.tax).toBe(10000);
    expect(totals.total).toBe(110050);
  });
  it('keeps exact minor-unit tax without an increment (backwards compatible)', () => {
    const totals = calculateTotals(base);
    expect(totals.tax).toBe(10005);
    expect(totals.total).toBe(110055);
  });
  it('extracts inclusive tax with the same rounding', () => {
    const totals = calculateTotals({ ...base, taxInclusive: true, roundingIncrement: 100 });
    // 100,050 * 10 / 110 = 9,095.45… → 9,100 at increment 100.
    expect(totals.tax).toBe(9100);
    expect(totals.total).toBe(100050);
  });
});
