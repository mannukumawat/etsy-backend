// Pure, database-free helpers for the product Excel import (C2–C4).
//
// The import file speaks INR; the database stores USD minor units (see
// shared/utils/currency.ts — "All seller-configured amounts live in USD minor
// units"). Every price in the file MUST pass through inrRupeesToUsdMinor at the
// store's configured INR rate (1 USD = rate INR) before it is stored. Treating
// the INR number as USD minor units made a ₹15,739 rug a $15,739 product.

import { MAX_STOCK_PER_VARIANT } from '../inventory/inventory.schema.js';

export { slugify } from '../../shared/utils/slugify.js';

export interface ImportRowError {
  /** 1-based Excel row number (row 1 is the header). */
  row: number;
  field: string;
  message: string;
}

/** Display name as imported: trimmed with collapsed internal whitespace. */
export function normalizeProductName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

/** Grouping key for rows that belong to the same product: case-insensitive, trimmed. */
export function productGroupKey(name: string): string {
  return normalizeProductName(name).toLowerCase();
}

/**
 * Convert an INR amount in rupees to USD minor units (cents) at the configured
 * rate (1 USD = `inrRate` INR). E.g. ₹15,739 at rate 100 → 15739 cents ($157.39);
 * at the seeded rate 84 → 18737 cents ($187.37). Never store the INR number raw.
 */
export function inrRupeesToUsdMinor(inrRupees: number, inrRate: number): number {
  if (!Number.isFinite(inrRate) || inrRate <= 0) {
    throw new Error('INR rate must be a positive number.');
  }
  return Math.round((inrRupees * 100) / inrRate);
}

/** Parse a price embedded in a size label, e.g. "2x3 Ft Kilim Rug (₹ 4,407)" → 4407 (rupees).
 *  KEPT for reference/tests only: since M-P5 the import no longer uses it — size_price_inr
 *  always wins and a ₹ price in the label is display text, not a price override. */
export function parseInrPriceFromLabel(label: string): number | null {
  const m = label.match(/₹\s*([\d,]+)/);
  if (!m) return null;
  return parseInt(m[1].replace(/,/g, ''), 10);
}

/** Raw cell value as a trimmed string ('' when blank/missing). */
export function cellString(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

/** Strict number cell: blank → null (caller decides the default); non-numeric → error message. */
export function parseNumberCell(raw: unknown): { value: number | null } | { error: string } {
  if (raw === undefined || raw === null || String(raw).trim() === '') return { value: null };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { error: `'${String(raw).trim()}' is not a number.` };
  return { value: n };
}

/** Strict stock cell: blank → null (default 10); must be a whole number ≥ 0. */
export function parseStockCell(raw: unknown): { value: number | null } | { error: string } {
  const parsed = parseNumberCell(raw);
  if ('error' in parsed) return parsed;
  if (parsed.value === null) return { value: null };
  if (!Number.isInteger(parsed.value) || parsed.value < 0) {
    return { error: `Stock must be a whole number of 0 or more, got '${String(raw).trim()}'.` };
  }
  if (parsed.value > MAX_STOCK_PER_VARIANT) return { error: `Stock cannot exceed ${MAX_STOCK_PER_VARIANT.toLocaleString('en-US')}.` };
  return { value: parsed.value };
}
