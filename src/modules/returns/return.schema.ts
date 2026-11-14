import { z } from 'zod';

export const cancelLineSchema = z.object({
  qty: z.number().int().min(1),
  reason: z.enum(['changed_mind', 'duplicate_order', 'wrong_item_ordered', 'price_issue', 'other']),
  note: z.string().max(500).optional(),
});
export type CancelLineInput = z.infer<typeof cancelLineSchema>;

export const createReturnSchema = z.object({
  orderId: z.string().min(1),
  lineId: z.string().min(1),
  qty: z.number().int().min(1),
  reason: z.enum(['damaged', 'wrong_item', 'not_as_described', 'changed_mind', 'quality_issue', 'other']),
  note: z.string().max(1000).optional(),
  photos: z.array(z.string()).max(5).optional().default([]),
  shippingMethod: z.enum(['self_ship', 'pickup']).optional(),
  refundAccountId: z.string().optional(),
});
export type CreateReturnInput = z.infer<typeof createReturnSchema>;

export const approveReturnSchema = z.object({
  approvedQty: z.number().int().min(1),
  shippingFee: z.number().int().min(0).optional(),
  note: z.string().max(1000).optional(),
});
export type ApproveReturnInput = z.infer<typeof approveReturnSchema>;

export const rejectReturnSchema = z.object({
  reason: z.string().min(1).max(1000),
});
export type RejectReturnInput = z.infer<typeof rejectReturnSchema>;

export const arrangePickupSchema = z.object({
  pickupAddress: z.string().min(1),
  carrier: z.string().optional(),
  note: z.string().max(500).optional(),
});
export type ArrangePickupInput = z.infer<typeof arrangePickupSchema>;

export const recordReturnShippingSchema = z.object({
  carrier: z.string().min(1),
  tracking: z.string().min(1),
});
export type RecordReturnShippingInput = z.infer<typeof recordReturnShippingSchema>;

export const receiveReturnSchema = z.object({
  receivedQty: z.number().int().min(0),
  note: z.string().max(500).optional(),
});
export type ReceiveReturnInput = z.infer<typeof receiveReturnSchema>;

export const inspectReturnSchema = z.object({
  acceptedQty: z.number().int().min(0),
  rejectedQty: z.number().int().min(0),
  restockAccepted: z.boolean().default(true),
  note: z.string().max(1000).optional(),
});
export type InspectReturnInput = z.infer<typeof inspectReturnSchema>;

export const processReturnRefundSchema = z.object({
  amount: z.number().int().min(1),
  method: z.enum(['original', 'manual_bank', 'manual_upi', 'store_credit']),
  reference: z.string().max(200).optional(),
  note: z.string().max(500).optional(),
});
export type ProcessReturnRefundInput = z.infer<typeof processReturnRefundSchema>;

export const addReturnNoteSchema = z.object({
  body: z.string().min(1).max(2000),
});
export type AddReturnNoteInput = z.infer<typeof addReturnNoteSchema>;
