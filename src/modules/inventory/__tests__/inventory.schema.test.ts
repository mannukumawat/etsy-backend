import { describe, expect, it } from 'vitest';
import { parseStockCell } from '../../import-export/import-format.js';
import { MAX_STOCK_PER_VARIANT, inventoryAdjustSchema } from '../inventory.schema.js';

// Pure validation: no database, no network. Covers L-I5 (one stock cap everywhere).

describe('stock cap (L-I5)', () => {
  it('is 100,000 per variant, shared with the admin form', () => {
    expect(MAX_STOCK_PER_VARIANT).toBe(100_000);
  });

  it('accepts an adjustment up to the cap and rejects above it', () => {
    const base = { variantId: 'v1', mode: 'set' as const, reason: 'restock' as const, note: '' };
    expect(() => inventoryAdjustSchema.parse({ ...base, quantity: 100_000 })).not.toThrow();
    expect(() => inventoryAdjustSchema.parse({ ...base, quantity: 100_001 })).toThrow();
    expect(() => inventoryAdjustSchema.parse({ ...base, quantity: 1_000_000 })).toThrow();
  });

  it('rejects an import stock cell above the cap', () => {
    expect(parseStockCell(100_000)).toEqual({ value: 100_000 });
    expect(parseStockCell(100_001)).toHaveProperty('error');
  });
});
