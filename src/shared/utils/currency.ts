// Currency conversion shared by checkout pricing and coupon rules. All seller-configured amounts
// (product prices, shipping rates, coupon values) live in USD minor units in the database; these helpers
// convert them to the customer's chosen currency using a rate snapshot captured once per request, which
// is then stored on the order so its historical total never drifts if rates change later.

export interface CurrencyConfigLike {
  code: string;
  rate: number;
  fractionDigits: number;
  roundingIncrement: number;
}

/** Stored in full (every configured currency's rate, not just the order's own) because the two apps
 *  read it differently: the storefront's `Order.rateSnapshot` is a full `{base, rates, asOf}` map
 *  (admin/src and frontend/src disagree on this shape — see mappers.ts toAdminOrder/toStorefrontOrder,
 *  which each project the stored shape into what their own app expects). */
export interface StoredRateSnapshot {
  base: 'USD';
  rates: Record<string, number>;
  asOf: string;
}

export function buildRateSnapshot(currencies: CurrencyConfigLike[]): StoredRateSnapshot {
  return { base: 'USD', rates: Object.fromEntries(currencies.map((c) => [c.code, c.rate])), asOf: new Date().toISOString() };
}

/** Rounds to the currency's rounding increment (e.g. 100 for whole-rupee INR, 1 for cent-precision
 *  currencies), half-away-from-zero — matches frontend/src/utils/money.ts exactly. */
export function roundMinor(amount: number, currency: Pick<CurrencyConfigLike, 'roundingIncrement'>): number {
  const inc = currency.roundingIncrement || 1;
  const sign = amount < 0 ? -1 : 1;
  return sign * Math.round(Math.abs(amount) / inc) * inc;
}

export function convertFromBase(baseMinor: number, currency: CurrencyConfigLike): number {
  return roundMinor(baseMinor * currency.rate, currency);
}
