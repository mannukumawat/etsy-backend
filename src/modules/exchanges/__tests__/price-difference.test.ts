import { describe, expect, it, vi } from 'vitest';

// Pure unit tests for the exchange price difference (H16). The helpers live in
// exchange.service.ts; Prisma is mocked so importing the service never touches
// a database. The key case is a non-USD order: the replacement price is
// USD-base while the line price is already converted, so comparing them raw
// (the old code) produces a wildly wrong — and wrong-signed — difference.
const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'mysql://user:pass@localhost:3306/testdb';
  process.env.JWT_SECRET ??= 'test-only-jwt-secret-0123456789';
  return {
    prisma: {
      order: { findFirst: vi.fn(), findMany: vi.fn(async () => []) },
      orderLine: { findUnique: vi.fn() },
      orderEvent: { findFirst: vi.fn(async () => null) },
      product: { findUnique: vi.fn() },
      productVariant: { findUnique: vi.fn() },
      currencyConfig: { findFirst: vi.fn() },
      exchangeRequest: { findUnique: vi.fn(), findMany: vi.fn(async () => []) },
      exchangeEvent: { findMany: vi.fn(async () => []), create: vi.fn() },
      $queryRawUnsafe: vi.fn(async () => { throw new Error('raw SQL must not be used'); }),
      $executeRawUnsafe: vi.fn(async () => { throw new Error('raw SQL must not be used'); }),
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
    },
  };
});
vi.mock('../../../shared/database/prisma.js', () => ({ prisma: mocks.prisma, assertDatabaseReachable: vi.fn() }));

import {
  computePriceDifference,
  convertedReplacementPrice,
  parseRateSnapshot,
  rateForOrderCurrency,
} from '../exchange.service.js';

const INR_SNAPSHOT = JSON.stringify({ base: 'USD', rates: { USD: 1, INR: 84, EUR: 0.92 }, asOf: '2026-11-20T00:00:00.000Z' });
const USD_SNAPSHOT = JSON.stringify({ base: 'USD', rates: { USD: 1 }, asOf: '2026-11-20T00:00:00.000Z' });
const INR_CONFIG = { fractionDigits: 2, roundingIncrement: 100 };
const USD_CONFIG = { fractionDigits: 2, roundingIncrement: 1 };

describe('parseRateSnapshot', () => {
  it('parses the stored full-map shape {base, rates, asOf}', () => {
    expect(parseRateSnapshot(INR_SNAPSHOT)).toEqual(
      expect.objectContaining({ rates: expect.objectContaining({ INR: 84 }) }),
    );
  });

  it('also accepts the legacy single-rate shape {base, currency, rate, capturedAt}', () => {
    const legacy = JSON.stringify({ base: 'USD', currency: 'INR', rate: 84, capturedAt: '2026-11-20T00:00:00.000Z' });
    expect(parseRateSnapshot(legacy)).toEqual(expect.objectContaining({ currency: 'INR', rate: 84 }));
  });

  it('returns an empty snapshot for unparsable JSON instead of throwing', () => {
    expect(parseRateSnapshot('not json')).toEqual({});
  });
});

describe('rateForOrderCurrency', () => {
  it('reads the order currency rate from the frozen snapshot', () => {
    expect(rateForOrderCurrency(INR_SNAPSHOT, 'INR')).toBe(84);
  });

  it('throws instead of guessing when the snapshot has no usable rate', () => {
    expect(() => rateForOrderCurrency(USD_SNAPSHOT, 'INR')).toThrow(/No usable exchange rate for INR/);
    expect(() => rateForOrderCurrency('not json', 'INR')).toThrow(/No usable exchange rate for INR/);
  });
});

describe('convertedReplacementPrice', () => {
  it('leaves a USD price unchanged for a USD order', () => {
    expect(convertedReplacementPrice(12000, 'USD', USD_SNAPSHOT, USD_CONFIG)).toBe(12000);
  });

  it('converts a USD-base price with the order rate for an INR order', () => {
    // $120.00 -> 12000 * 84 = 1,008,000 paise.
    expect(convertedReplacementPrice(12000, 'INR', INR_SNAPSHOT, INR_CONFIG)).toBe(1008000);
  });

  it('rounds to the currency rounding increment (whole rupees)', () => {
    // $100.01 -> 10001 * 84 = 840,084 -> nearest 100 = 840,100.
    expect(convertedReplacementPrice(10001, 'INR', INR_SNAPSHOT, INR_CONFIG)).toBe(840100);
  });
});

describe('computePriceDifference (H16)', () => {
  it('computes the difference from converted prices in a USD order', () => {
    expect(
      computePriceDifference({
        replacementBaseMinor: 12000,
        lineUnitPrice: 10000,
        qty: 2,
        currency: 'USD',
        rateSnapshotJson: USD_SNAPSHOT,
        currencyConfig: USD_CONFIG,
      }),
    ).toBe(4000);
  });

  it('computes the difference from converted prices in an INR order (the old code mixed currencies)', () => {
    // Replacement $120 -> 1,008,000 paise; line was $100 -> 840,000 paise.
    // Difference for 1 unit: +168,000 paise (customer owes ₹1,680).
    // The old code compared USD-base 12,000 against converted 840,000 and
    // produced -828,000 — a phantom refund of ₹8,280.
    expect(
      computePriceDifference({
        replacementBaseMinor: 12000,
        lineUnitPrice: 840000,
        qty: 1,
        currency: 'INR',
        rateSnapshotJson: INR_SNAPSHOT,
        currencyConfig: INR_CONFIG,
      }),
    ).toBe(168000);
  });

  it('is negative when the replacement is cheaper (customer overpaid)', () => {
    expect(
      computePriceDifference({
        replacementBaseMinor: 8000,
        lineUnitPrice: 840000,
        qty: 1,
        currency: 'INR',
        rateSnapshotJson: INR_SNAPSHOT,
        currencyConfig: INR_CONFIG,
      }),
    ).toBe(8000 * 84 - 840000);
  });

  it('multiplies the per-unit difference by the quantity', () => {
    expect(
      computePriceDifference({
        replacementBaseMinor: 12000,
        lineUnitPrice: 840000,
        qty: 3,
        currency: 'INR',
        rateSnapshotJson: INR_SNAPSHOT,
        currencyConfig: INR_CONFIG,
      }),
    ).toBe(168000 * 3);
  });
});
