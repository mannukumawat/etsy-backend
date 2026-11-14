import { z } from 'zod';

export const customerEmailField = z.string().trim().min(1).email('Enter a valid email address.').max(120);
export const customerPasswordField = z
  .string()
  .min(8, 'Use at least 8 characters.')
  .max(72)
  .regex(/[A-Za-z]/, 'Include at least one letter.')
  .regex(/\d/, 'Include at least one number.');

const phoneDigits = (v: string) => v.replace(/[\s\-().]/g, '');
/** Profile phone: optional, allows a leading "+" (matches frontend/src/utils/validation.ts profileSchema). */
export const customerPhoneField = z
  .string()
  .trim()
  .refine((v) => v === '' || /^\+?\d{6,15}$/.test(phoneDigits(v)), 'Enter a valid phone number.')
  .default('');

export const customerRegisterSchema = z.object({
  name: z.string().trim().min(2, 'Enter your full name.').max(80),
  email: customerEmailField,
  password: customerPasswordField,
});
export type CustomerRegisterInput = z.infer<typeof customerRegisterSchema>;

export const customerLoginSchema = z.object({ email: customerEmailField, password: z.string().min(1, 'Password is required.') });

export const customerProfileSchema = z.object({
  name: z.string().trim().min(2, 'Enter your full name.').max(80),
  email: customerEmailField,
  phone: customerPhoneField,
});
export type CustomerProfileInput = z.infer<typeof customerProfileSchema>;

export const customerAddressSchema = z.object({
  label: z.string().trim().min(1, 'Label is required.').max(30),
  isDefault: z.boolean().default(false),
  fullName: z.string().trim().min(2, 'Enter a full name.').max(80),
  phoneCountry: z.string().trim().min(1, 'Required.'),
  phone: z.string().trim().min(1, 'Phone is required.').refine((v) => /^\d{6,14}$/.test(phoneDigits(v)), 'Enter a valid phone number.'),
  country: z.string().length(2, 'Choose a country.'),
  line1: z.string().trim().min(3, 'Address line is required.').max(120),
  line2: z.string().trim().max(120).default(''),
  city: z.string().trim().max(80).default(''),
  region: z.string().trim().max(80).default(''),
  postalCode: z.string().trim().max(12).default(''),
});
export type CustomerAddressInput = z.infer<typeof customerAddressSchema>;

export const passwordResetRequestSchema = z.object({ email: customerEmailField });
export const passwordResetConfirmSchema = z.object({
  token: z.string().min(1, 'Reset link is invalid.'),
  password: customerPasswordField,
});

export const wishlistToggleSchema = z.object({ productId: z.string().min(1), variantId: z.string().min(1).optional() });
