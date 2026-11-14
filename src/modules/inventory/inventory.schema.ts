import { z } from 'zod';

export const ADJUSTMENT_REASONS = ['restock', 'correction', 'damaged', 'returned', 'other'] as const;

export const inventoryAdjustSchema = z
  .object({
    variantId: z.string().min(1),
    mode: z.enum(['add', 'remove', 'set']),
    quantity: z.number().int('Whole numbers only.').min(0, 'Cannot be negative.').max(1_000_000),
    reason: z.enum(ADJUSTMENT_REASONS),
    note: z.string().trim().max(300).default(''),
  })
  .refine((v) => v.reason !== 'other' || v.note.length >= 3, { message: 'Add a note of at least 3 characters for "Other".', path: ['note'] });
export type InventoryAdjustInput = z.infer<typeof inventoryAdjustSchema>;
