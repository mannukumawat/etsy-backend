import { z } from 'zod';
import { customerAddressSchema, customerEmailField } from '../customers/customer.schema.js';
import { SUPPORTED_CURRENCY_CODES } from '../settings/settings.schema.js';

export const orderAddressSchema = customerAddressSchema.omit({ label: true, isDefault: true });
export type OrderAddressInput = z.infer<typeof orderAddressSchema>;

export const checkoutLineSchema = z.object({
  productId: z.string().min(1),
  variantId: z.string().min(1),
  quantity: z.number().int('Whole numbers only.').min(1).max(10),
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
  shippingMethodId: z.enum(['standard', 'express']),
  couponCode: z.string().trim().max(30).optional(),
});
export type CheckoutTotalsInput = z.infer<typeof checkoutTotalsSchema>;

export const PAYMENT_METHODS = ['cod', 'card', 'upi', 'wallet'] as const;

export const placeOrderSchema = z.object({
  idempotencyKey: z.string().trim().min(1, 'Missing idempotency key.').max(100),
  lines: z.array(checkoutLineSchema).min(1, 'Your cart is empty.').max(50),
  currency: z.enum(SUPPORTED_CURRENCY_CODES),
  email: customerEmailField,
  address: orderAddressSchema,
  shippingMethodId: z.enum(['standard', 'express']),
  paymentMethod: z.enum(PAYMENT_METHODS),
  couponCode: z.string().trim().max(30).optional(),
});
export type PlaceOrderInput = z.infer<typeof placeOrderSchema>;
