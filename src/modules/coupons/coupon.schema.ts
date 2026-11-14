import { z } from 'zod';

export const COUPON_CODE_RE = /^[A-Z0-9][A-Z0-9_-]{2,19}$/;
export const normalizeCouponCode = (code: string) => code.trim().toUpperCase();

export const couponInputSchema = z
  .object({
    code: z.string().trim().transform(normalizeCouponCode).pipe(z.string().regex(COUPON_CODE_RE, 'Code: 3–20 characters, letters, numbers, "-" or "_".')),
    description: z.string().trim().max(300).default(''),
    type: z.enum(['percentage', 'fixed']),
    value: z.number(),
    maxDiscount: z.number().int().nullable().default(null),
    minOrder: z.number().int().nullable().default(null),
    startsAt: z.coerce.date().nullable().default(null),
    endsAt: z.coerce.date().nullable().default(null),
    isActive: z.boolean().default(true),
    usageLimit: z.number().int().nullable().default(null),
    perCustomerLimit: z.number().int().nullable().default(null),
    scope: z.enum(['all', 'products', 'categories']).default('all'),
    productIds: z.array(z.string()).default([]),
    categoryIds: z.array(z.string()).default([]),
  })
  .superRefine((input, ctx) => {
    const add = (path: (string | number)[], message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
    if (input.type === 'percentage') {
      if (!Number.isFinite(input.value) || input.value <= 0 || input.value > 100) add(['value'], 'Percentage must be more than 0 and at most 100.');
      if (input.maxDiscount !== null && input.maxDiscount <= 0) add(['maxDiscount'], 'Maximum discount must be above zero, or empty.');
    } else {
      if (!Number.isInteger(input.value) || input.value <= 0) add(['value'], 'Fixed discount must be above zero.');
      if (input.maxDiscount !== null) add(['maxDiscount'], 'Maximum discount only applies to percentage coupons.');
    }
    if (input.minOrder !== null && input.minOrder < 0) add(['minOrder'], 'Minimum order cannot be negative.');
    if (input.type === 'fixed' && input.minOrder !== null && input.minOrder > 0 && input.value > input.minOrder) {
      add(['value'], 'A fixed discount larger than the minimum order could make orders free.');
    }
    if (input.startsAt && input.endsAt && input.endsAt <= input.startsAt) add(['endsAt'], 'End date must be after the start date.');
    const posInt = (n: number | null) => n === null || (Number.isInteger(n) && n >= 1);
    if (!posInt(input.usageLimit)) add(['usageLimit'], 'Usage limit must be a whole number of at least 1, or empty.');
    if (!posInt(input.perCustomerLimit)) add(['perCustomerLimit'], 'Per-customer limit must be at least 1, or empty.');
    if (input.usageLimit !== null && input.perCustomerLimit !== null && input.perCustomerLimit > input.usageLimit) {
      add(['perCustomerLimit'], 'Per-customer limit cannot exceed the total usage limit.');
    }
    if (input.scope === 'products' && input.productIds.length === 0) add(['productIds'], 'Choose at least one product.');
    if (input.scope === 'categories' && input.categoryIds.length === 0) add(['categoryIds'], 'Choose at least one category.');
  });
export type CouponInput = z.infer<typeof couponInputSchema>;
