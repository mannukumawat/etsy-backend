import { convertFromBase, type CurrencyConfigLike } from '../../shared/utils/currency.js';
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
