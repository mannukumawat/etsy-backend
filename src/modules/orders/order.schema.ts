import { z } from 'zod';
import { customerEmailField } from '../customers/customer.schema.js';

export const orderTrackSchema = z.object({
  number: z.string().trim().min(1, 'Enter your order number.'),
  email: customerEmailField,
});
export type OrderTrackInput = z.infer<typeof orderTrackSchema>;

export const ADMIN_FULFILMENT_STATUSES = ['unfulfilled', 'processing', 'shipped', 'delivered', 'cancelled'] as const;

export const advanceOrderSchema = z
  .object({
    to: z.enum(ADMIN_FULFILMENT_STATUSES),
    carrier: z.string().trim().max(60).optional(),
    trackingNumber: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9-]{4,40}$/, 'Use 4–40 letters, numbers or hyphens.')
      .optional(),
    trackingUrl: z.string().trim().url('Enter a valid URL.').optional().or(z.literal('')),
  })
  .superRefine((input, ctx) => {
    if (input.to === 'shipped' && (!input.carrier?.trim() || !input.trackingNumber)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['trackingNumber'], message: 'Carrier and tracking number are required to mark an order shipped.' });
    }
  });
export type AdvanceOrderInput = z.infer<typeof advanceOrderSchema>;

export const updateTrackingSchema = z.object({
  carrier: z.string().trim().min(1, 'Carrier is required.').max(60),
  trackingNumber: z.string().trim().regex(/^[A-Za-z0-9-]{4,40}$/, 'Use 4–40 letters, numbers or hyphens.'),
  trackingUrl: z.string().trim().url('Enter a valid URL.').optional().or(z.literal('')),
});
export type UpdateTrackingInput = z.infer<typeof updateTrackingSchema>;

export const cancelOrderSchema = z.object({
  restock: z.boolean().default(true),
  refund: z.boolean().default(true),
  reason: z.string().trim().min(1, 'Give a reason for the cancellation.').max(300),
});
export type CancelOrderInput = z.infer<typeof cancelOrderSchema>;

export const refundOrderSchema = z.object({
  amount: z.number().int('Use whole minor units.').positive('Refund must be above zero.'),
  reason: z.string().trim().min(1, 'Give a reason for the refund.').max(300),
  /** 'original' refunds through Razorpay; manual methods record a pending refund to verify later. */
  method: z.enum(['original', 'manual_bank', 'manual_upi', 'store_credit']).default('original'),
  /** Bank/UPI reference — required for manual refunds. */
  reference: z.string().trim().max(200).optional(),
  note: z.string().trim().max(500).optional(),
});
export type RefundOrderInput = z.infer<typeof refundOrderSchema>;

export const addNoteSchema = z.object({ body: z.string().trim().min(1, 'Note cannot be empty.').max(1000) });
export type AddNoteInput = z.infer<typeof addNoteSchema>;

/** M5: marking an order paid needs proof — a payment reference, or an explicit
 *  manual-reconciliation override with a mandatory audit note. */
export const markOrderPaidSchema = z
  .object({
    paymentReference: z.string().trim().max(255).optional(),
    note: z.string().trim().max(500).optional(),
    force: z.boolean().default(false),
  })
  .superRefine((input, ctx) => {
    if (!input.paymentReference?.trim() && !input.force) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['paymentReference'], message: 'A payment reference is required, or use the manual reconciliation override with an audit note.' });
    }
    if (input.force && !input.note?.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['note'], message: 'A manual reconciliation without a payment reference requires an audit note.' });
    }
  });
export type MarkOrderPaidInput = z.infer<typeof markOrderPaidSchema>;

