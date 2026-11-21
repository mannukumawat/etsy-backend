import { describe, expect, it } from 'vitest';
import {
  cellString,
  inrRupeesToUsdMinor,
  normalizeProductName,
  parseInrPriceFromLabel,
  parseNumberCell,
  parseStockCell,
  productGroupKey,
  slugify,
} from '../import-format.js';

// Pure helpers: no database, no network.

describe('inrRupeesToUsdMinor (C2)', () => {
  it('converts the ₹15,739 audit example to $157.39 at rate 100, not $15,739', () => {
    expect(inrRupeesToUsdMinor(15739, 100)).toBe(15739); // 15739 cents = $157.39
  });

  it('converts at the configured live rate (seed INR 84 → $187.37)', () => {
    expect(inrRupeesToUsdMinor(15739, 84)).toBe(18737);
  });

  it('rounds to whole cents', () => {
    expect(inrRupeesToUsdMinor(100, 3)).toBe(3333);
  });

  it('rejects a missing or zero rate instead of dividing by it', () => {
    expect(() => inrRupeesToUsdMinor(100, 0)).toThrow();
    expect(() => inrRupeesToUsdMinor(100, Number.NaN)).toThrow();
  });
});

describe('parseInrPriceFromLabel', () => {
  it('parses ₹ amounts with commas as rupees (not paise)', () => {
    expect(parseInrPriceFromLabel('2x3 Ft Kilim Rug (₹ 4,407)')).toBe(4407);
    expect(parseInrPriceFromLabel('6x9 Ft (₹26,746)')).toBe(26746);
  });

  it('returns null when the label has no ₹ price', () => {
    expect(parseInrPriceFromLabel('2x3 Ft')).toBeNull();
  });
});

describe('product grouping (C4)', () => {
  it('groups case-insensitively with collapsed whitespace', () => {
    expect(productGroupKey('Kilim  Rug')).toBe(productGroupKey('kilim rug'));
    expect(productGroupKey('  Rug ')).toBe('rug');
  });

  it('slugifies names the same way the service stores them', () => {
    expect(slugify('Natural Wool Kilim Rug - Charcoal Geometric')).toBe('natural-wool-kilim-rug-charcoal-geometric');
  });

  it('normalizes display names', () => {
    expect(normalizeProductName('  Kilim   Rug ')).toBe('Kilim Rug');
  });
});

describe('strict cell parsing (C4)', () => {
  it('blank stock is null (caller defaults to 10); non-numeric and negative stock are errors', () => {
    expect(parseStockCell('')).toEqual({ value: null });
    expect(parseStockCell(undefined)).toEqual({ value: null });
    expect(parseStockCell('3')).toEqual({ value: 3 });
    expect(parseStockCell('abc')).toHaveProperty('error');
    expect(parseStockCell('-1')).toHaveProperty('error');
    expect(parseStockCell('1.5')).toHaveProperty('error');
  });

  it('blank numbers are null; non-numeric numbers are errors', () => {
    expect(parseNumberCell('')).toEqual({ value: null });
    expect(parseNumberCell('15739')).toEqual({ value: 15739 });
    expect(parseNumberCell('12x')).toHaveProperty('error');
  });

  it('reads cells as trimmed strings', () => {
    expect(cellString({ a: '  Kilim Rug ' }, 'a')).toBe('Kilim Rug');
    expect(cellString({}, 'a')).toBe('');
  });
});
