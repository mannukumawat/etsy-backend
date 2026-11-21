import { z } from 'zod';
import { customerAddressSchema, customerEmailField } from '../customers/customer.schema.js';
import { SUPPORTED_CURRENCY_CODES } from '../settings/settings.schema.js';

export const orderAddressSchema = customerAddressSchema.omit({ label: true, isDefault: true });
export type OrderAddressInput = z.infer<typeof orderAddressSchema>;

export const checkoutLineSchema = z.object({
  productId: z.string().min(1),
  variantId: z.string().min(1),
  // Static ceiling is the widest the store setting allows (1–99); the live
  // maxQtyPerLine from settings is enforced per request in computePreview (M-S1),
  // so lowering the setting immediately lowers what checkout accepts.
  quantity: z.number().int('Whole numbers only.').min(1).max(99),
});

export const validateCouponSchema = z.object({
  code: z.string().trim().min(1).max(30),
  lines: z.array(checkoutLineSchema).min(1),
  currency: z.enum(SUPPORTED_CURRENCY_CODES),
});
export type ValidateCouponInput = z.infer<typeof validateCouponSchema>;

export const checkoutTotalsSchema = z.object({
  lines: z.array(checkoutLineSchema).min(1, 'Your cart is empty.').max(50),
  currency: z.enum(SUPPORTED_CURRENCY_CODES),
  country: z.string().length(2, 'Choose a destination country.'),
  /** Optional shipping-address region/state for regional tax rule matching. */
  region: z.string().trim().max(80).optional(),
  shippingMethodId: z.enum(['standard', 'express']),
  couponCode: z.string().trim().max(30).optional(),
});
export type CheckoutTotalsInput = z.infer<typeof checkoutTotalsSchema>;

export const PAYMENT_METHODS = ['card', 'upi', 'wallet'] as const;

/**
 * POST /razorpay/create-order body. The receipt is derived server-side from the
 * idempotency key (L4) — the client sends `idempotencyKey`, and may echo the
 * receipt, but a receipt that differs from the key is rejected.
 */
export const createRazorpayOrderSchema = checkoutTotalsSchema.extend({
  idempotencyKey: z.string().trim().min(1, 'Missing idempotency key.').max(100),
  receipt: z.string().min(1).max(40).optional(),
  walletPartialPaise: z.number().int().min(0).optional(),
  paymentMethod: z.enum(PAYMENT_METHODS).optional(),
});
export type CreateRazorpayOrderInput = z.infer<typeof createRazorpayOrderSchema>;

export const placeOrderSchema = z.object({
  idempotencyKey: z.string().trim().min(1, 'Missing idempotency key.').max(100),
  lines: z.array(checkoutLineSchema).min(1, 'Your cart is empty.').max(50),
  currency: z.enum(SUPPORTED_CURRENCY_CODES),
  email: customerEmailField,
  address: orderAddressSchema,
  shippingMethodId: z.enum(['standard', 'express']),
  paymentMethod: z.enum(PAYMENT_METHODS),
  couponCode: z.string().trim().max(30).optional(),
  /** Razorpay payment details — required for card/upi/wallet (Razorpay). */
  razorpayOrderId: z.string().optional(),
  razorpayPaymentId: z.string().optional(),
  razorpaySignature: z.string().optional(),
  /**
   * Amount in INR paise to pay from the customer's store wallet.
   * 0 or absent = no wallet payment. Must equal the full order total for a full-wallet
   * order (paymentMethod 'wallet'); use walletPartialPaise for a split payment instead.
   * When set to the full order total, no Razorpay order is required and paymentMethod should be 'wallet'.
   */
  walletAmountPaise: z.number().int().min(0).optional(),
  /**
   * Amount in INR paise to debit from the customer's store wallet as part of a SPLIT
   * payment (signed-in customers only, INR orders only). Razorpay is charged only the
   * remainder (total - walletPartialPaise). Must satisfy 0 < partial < total and
   * partial <= the customer's actual wallet balance — both are re-checked server-side
   * against the authoritative total and the DB balance; the client-sent value is never
   * trusted. A partial equal to the total is treated as a full-wallet payment.
   * Mutually exclusive with walletAmountPaise.
   */
  walletPartialPaise: z.number().int().min(0).optional(),
}).superRefine((v, ctx) => {
  if ((v.walletAmountPaise ?? 0) > 0 && (v.walletPartialPaise ?? 0) > 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['walletPartialPaise'], message: 'Use either a full wallet payment or a partial wallet payment, not both.' });
  }
  if ((v.walletPartialPaise ?? 0) > 0 && v.paymentMethod === 'wallet') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['walletPartialPaise'], message: 'Partial wallet payment needs a card/UPI payment for the remainder; use walletAmountPaise for a full wallet payment.' });
  }
});
export type PlaceOrderInput = z.infer<typeof placeOrderSchema>;
