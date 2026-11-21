import { z } from 'zod';

/** L-I5: one stock cap for the whole system — the admin form, the adjust endpoint,
 *  product saves and imports all reject stock above this. (Was 100,000 in the admin
 *  form and 1,000,000 in the backend, so a 500k restock was legal via API but
 *  impossible from the UI.) */
export const MAX_STOCK_PER_VARIANT = 100_000;

export const ADJUSTMENT_REASONS = ['restock', 'correction', 'damaged', 'returned', 'other'] as const;

export const inventoryAdjustSchema = z
  .object({
    variantId: z.string().min(1),
    mode: z.enum(['add', 'remove', 'set']),
    quantity: z.number().int('Whole numbers only.').min(0, 'Cannot be negative.').max(MAX_STOCK_PER_VARIANT),
    reason: z.enum(ADJUSTMENT_REASONS),
    note: z.string().trim().max(300).default(''),
  })
  .refine((v) => v.reason !== 'other' || v.note.length >= 3, { message: 'Add a note of at least 3 characters for "Other".', path: ['note'] });
export type InventoryAdjustInput = z.infer<typeof inventoryAdjustSchema>;
