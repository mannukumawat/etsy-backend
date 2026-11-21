import { convertFromBase, roundMinor, type CurrencyConfigLike } from '../../shared/utils/currency.js';
import { parseStringArray } from '../../shared/utils/json.js';

// The shared shipping/tax/totals engine used by the checkout-totals preview and by order placement,
// so a preview and the order it leads to can never disagree. All seller-configured amounts (product
// prices, shipping rates, coupon values) live in USD minor units in the database;
// shared/utils/currency.ts converts them to the customer's chosen currency using a rate snapshot
// captured once per request, which is then stored on the order so its historical total never drifts
// if rates change later. Coupon rules live in modules/coupons/coupon-rules.service.ts.

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
 *  destination has no zone or every method in its zone is disabled — the "unsupported" state.
 *  M-S2: when `freeShipping` is given and the goods subtotal (after discounts, in the same
 *  currency minor units) reaches the threshold, every method costs 0 — free shipping. */
export function getShippingQuotes(zones: ShippingZoneLike[], countryCode: string, currency: CurrencyConfigLike, freeShipping?: { thresholdMinor: number; subtotalMinor: number }): ShippingQuote[] {
  const zone = zoneForCountry(zones, countryCode);
  if (!zone) return [];
  const free = freeShipping !== undefined && freeShipping.subtotalMinor >= freeShipping.thresholdMinor;
  const quotes: ShippingQuote[] = [];
  if (zone.standardEnabled) {
    quotes.push({ id: 'standard', label: 'Standard', amount: free ? 0 : convertFromBase(zone.standardRate, currency), minDays: zone.standardMinDays, maxDays: zone.standardMaxDays });
  }
  if (zone.expressEnabled) {
    quotes.push({ id: 'express', label: 'Express', amount: free ? 0 : convertFromBase(zone.expressRate, currency), minDays: zone.expressMinDays, maxDays: zone.expressMaxDays });
  }
  return quotes;
}

export function getShippingQuote(zones: ShippingZoneLike[], countryCode: string, methodId: 'standard' | 'express', currency: CurrencyConfigLike, freeShipping?: { thresholdMinor: number; subtotalMinor: number }): ShippingQuote | null {
  return getShippingQuotes(zones, countryCode, currency, freeShipping).find((q) => q.id === methodId) ?? null;
}

// --- Tax -------------------------------------------------------------------------------------------

export interface TaxRuleLike {
  country: string;
  region: string;
  rate: number;
}

/** The most specific matching rule wins (country+region over a blanket country rule); falls back to
 *  the store's default rate when nothing matches, matching the original per-country illustrative rate.
 *  L-S4: matching is case-insensitive (and trims whitespace) on BOTH sides, exactly like the admin
 *  tax preview — a rule saved as "california" now matches a checkout region of "California". */
export function getTaxRate(rules: TaxRuleLike[], defaultRate: number, countryCode: string, region: string | null | undefined): number {
  const country = countryCode.trim().toUpperCase();
  const needle = region?.trim().toLowerCase() || '';
  const regionMatch = needle ? rules.find((r) => r.country.trim().toUpperCase() === country && r.region.trim().toLowerCase() === needle) : undefined;
  if (regionMatch) return regionMatch.rate;
  const countryMatch = rules.find((r) => r.country.trim().toUpperCase() === country && r.region.trim() === '');
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
  /**
   * Currency rounding increment for the tax amount (L3). Defaults to 1 (exact minor
   * units) when the caller does not pass one — the checkout totals caller passes
   * the order currency's increment so tax rounds like every other converted amount.
   */
  roundingIncrement?: number;
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
  // Inclusive: tax is already inside the gross subtotal — extract it with the gross-up formula.
  // Exclusive: tax is added on top. Both formulas use integer arithmetic to avoid float drift,
  // then round through the currency's rounding increment (L3) like every other converted amount.
  const rounding = { roundingIncrement: input.roundingIncrement ?? 1 };
  const tax = input.taxInclusive
    ? roundMinor((taxable * input.taxRate) / (100 + input.taxRate), rounding)
    : roundMinor(taxable * (input.taxRate / 100), rounding);
  const total = input.taxInclusive ? taxable + input.shipping : taxable + input.shipping + tax;
  return { subtotal, discount, taxable, tax, shipping: input.shipping, total };
}
