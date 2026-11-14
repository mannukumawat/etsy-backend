import { z } from 'zod';

export const createExchangeSchema = z.object({
  orderId: z.string().min(1),
  lineId: z.string().min(1),
  qty: z.number().int().min(1),
  reason: z.enum(['wrong_size', 'wrong_color', 'damaged', 'not_as_described', 'changed_mind', 'other']),
  note: z.string().max(1000).optional(),
  replacementVariantId: z.string().min(1),
});
export type CreateExchangeInput = z.infer<typeof createExchangeSchema>;

export const approveExchangeSchema = z.object({
  approvedQty: z.number().int().min(1),
  note: z.string().max(1000).optional(),
});
export type ApproveExchangeInput = z.infer<typeof approveExchangeSchema>;

export const rejectExchangeSchema = z.object({
  reason: z.string().min(1).max(1000),
});
export type RejectExchangeInput = z.infer<typeof rejectExchangeSchema>;

export const shipExchangeSchema = z.object({
  carrier: z.string().min(1),
  tracking: z.string().min(1),
});
export type ShipExchangeInput = z.infer<typeof shipExchangeSchema>;
