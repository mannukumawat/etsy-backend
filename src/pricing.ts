import { parseStringArray } from './json.js';

// The shared money/shipping/tax/coupon engine used by the checkout-totals preview and by order
// placement, so a preview and the order it leads to can never disagree. All seller-configured
// amounts (product prices, shipping rates, coupon values) live in USD minor units in the database;
// this module converts them to the customer's chosen currency using a rate snapshot captured once
// per request, which is then stored on the order so its historical total never drifts if rates
// change later.

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

// --- Shipping ------------------------------------------------------------------------------------

export interface ShippingZoneLike {
  id: string;
  nameEn: string;
  countries: string;
  standardEnabled: boolean;
  standardRate: number;
  standardMinDays: number;
  standardMaxDays: number;
  expressEnabled: boolean;
  expressRate: number;
  expressMinDays: number;
  expressMaxDays: number;
}

export interface ShippingQuote {
  id: 'standard' | 'express';
  label: string;
  amount: number;
  minDays: number;
  maxDays: number;
}

function zoneForCountry(zones: ShippingZoneLike[], countryCode: string): ShippingZoneLike | null {
  return zones.find((z) => parseStringArray(z.countries).includes(countryCode)) ?? null;
}

/** All shipping methods available to a destination, converted to the given currency. Empty when the
 *  destination has no zone or every method in its zone is disabled — the "unsupported" state. */
export function getShippingQuotes(zones: ShippingZoneLike[], countryCode: string, currency: CurrencyConfigLike): ShippingQuote[] {
  const zone = zoneForCountry(zones, countryCode);
  if (!zone) return [];
  const quotes: ShippingQuote[] = [];
  if (zone.standardEnabled) {
    quotes.push({ id: 'standard', label: 'Standard', amount: convertFromBase(zone.standardRate, currency), minDays: zone.standardMinDays, maxDays: zone.standardMaxDays });
  }
  if (zone.expressEnabled) {
    quotes.push({ id: 'express', label: 'Express', amount: convertFromBase(zone.expressRate, currency), minDays: zone.expressMinDays, maxDays: zone.expressMaxDays });
  }
  return quotes;
}

export function getShippingQuote(zones: ShippingZoneLike[], countryCode: string, methodId: 'standard' | 'express', currency: CurrencyConfigLike): ShippingQuote | null {
  return getShippingQuotes(zones, countryCode, currency).find((q) => q.id === methodId) ?? null;
}

// --- Tax -------------------------------------------------------------------------------------------

export interface TaxRuleLike {
  country: string;
  region: string;
  rate: number;
}

/** The most specific matching rule wins (country+region over a blanket country rule); falls back to
 *  the store's default rate when nothing matches, matching the original per-country illustrative rate. */
export function getTaxRate(rules: TaxRuleLike[], defaultRate: number, countryCode: string, region: string | null | undefined): number {
  const regionMatch = region ? rules.find((r) => r.country === countryCode && r.region === region) : undefined;
  if (regionMatch) return regionMatch.rate;
  const countryMatch = rules.find((r) => r.country === countryCode && r.region === '');
  if (countryMatch) return countryMatch.rate;
  return defaultRate;
}

// --- Totals ----------------------------------------------------------------------------------------

export interface TotalsInput {
  /** Each line's quantity * (converted, rounded unit price) — already in the target currency. */
  lineTotals: number[];
  /** Already converted to the target currency. */
  discount: number;
  /** Already converted to the target currency. */
  shipping: number;
  /** 0-50, a percentage. */
  taxRate: number;
  /** When true, `tax` is informational only (already inside subtotal) and is not added to the total. */
  taxInclusive: boolean;
}

export interface Totals {
  subtotal: number;
  discount: number;
  taxable: number;
  tax: number;
  shipping: number;
  total: number;
}

export function calculateTotals(input: TotalsInput): Totals {
  const subtotal = input.lineTotals.reduce((sum, n) => sum + n, 0);
  const discount = Math.min(input.discount, subtotal);
  const taxable = Math.max(0, subtotal - discount);
  const tax = Math.round(taxable * (input.taxRate / 100));
  const total = input.taxInclusive ? taxable + input.shipping : taxable + input.shipping + tax;
  return { subtotal, discount, taxable, tax, shipping: input.shipping, total };
}

// --- Coupons ---------------------------------------------------------------------------------------

export interface CouponLike {
  type: string; // 'percentage' | 'fixed'
  value: number;
  maxDiscount: number | null;
  minOrder: number | null;
  startsAt: Date | null;
  endsAt: Date | null;
  isActive: boolean;
  usageLimit: number | null;
  perCustomerLimit: number | null;
  timesUsed: number;
  scope: string; // 'all' | 'products' | 'categories'
  productIds: string;
  categoryIds: string;
}

export type CouponState = 'active' | 'scheduled' | 'expired' | 'inactive' | 'exhausted';

export function couponState(c: CouponLike, now: Date): CouponState {
  if (!c.isActive) return 'inactive';
  if (c.usageLimit != null && c.timesUsed >= c.usageLimit) return 'exhausted';
  if (c.startsAt && c.startsAt > now) return 'scheduled';
  if (c.endsAt && c.endsAt < now) return 'expired';
  return 'active';
}

export interface CartLineForCoupon {
  productId: string;
  categoryId: string;
  /** Already converted to the order's currency. */
  lineTotal: number;
  /** Base (USD) unit price, used to convert the coupon's own USD-base amounts consistently. */
}

export interface CouponEvaluation {
  ok: boolean;
  error?: string;
  /** Converted to the order's currency. */
  discount: number;
}

/** Re-implements admin/src/utils/couponRules.ts `evaluateCoupon` exactly, operating on already
 *  currency-converted line totals. Coupon `value`/`maxDiscount`/`minOrder` are USD-base and are
 *  converted here via the same rate snapshot as everything else. */
export function evaluateCoupon(
  coupon: CouponLike,
  lines: CartLineForCoupon[],
  currency: CurrencyConfigLike,
  now: Date,
  priorUsesByThisCustomer: number,
): CouponEvaluation {
  const state = couponState(coupon, now);
  if (state !== 'active') return { ok: false, error: `This coupon is ${state}.`, discount: 0 };
  if (coupon.perCustomerLimit != null && priorUsesByThisCustomer >= coupon.perCustomerLimit) {
    return { ok: false, error: 'You have already used this coupon the maximum number of times.', discount: 0 };
  }

  const subtotal = lines.reduce((sum, l) => sum + l.lineTotal, 0);
  const minOrder = coupon.minOrder != null ? convertFromBase(coupon.minOrder, currency) : null;
  if (minOrder != null && subtotal < minOrder) {
    return { ok: false, error: 'Your order does not meet this coupon’s minimum amount.', discount: 0 };
  }

  const productIds = new Set(parseStringArray(coupon.productIds));
  const categoryIds = new Set(parseStringArray(coupon.categoryIds));
  const eligibleLines =
    coupon.scope === 'products' ? lines.filter((l) => productIds.has(l.productId))
    : coupon.scope === 'categories' ? lines.filter((l) => categoryIds.has(l.categoryId))
    : lines;
  const eligibleSubtotal = eligibleLines.reduce((sum, l) => sum + l.lineTotal, 0);
  if (eligibleSubtotal <= 0) return { ok: false, error: 'No items in your cart are eligible for this coupon.', discount: 0 };

  const maxDiscount = coupon.maxDiscount != null ? convertFromBase(coupon.maxDiscount, currency) : null;
  let discount: number;
  if (coupon.type === 'percentage') {
    discount = Math.round(eligibleSubtotal * (coupon.value / 100));
    if (maxDiscount != null) discount = Math.min(discount, maxDiscount);
  } else {
    discount = convertFromBase(coupon.value, currency);
  }
  discount = Math.min(discount, eligibleSubtotal);
  return { ok: true, discount };
}
