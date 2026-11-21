import { z } from 'zod';

export const loginSchema = z.object({
  email: z.string().trim().email('Enter a valid email address.'),
  password: z.string().min(1, 'Password is required.'),
});

export const forgotPasswordSchema = z.object({
  email: z.string().trim().email('Enter a valid email address.'),
});

export const resetPasswordSchema = z.object({
  token: z.string().trim().min(1, 'Reset link is missing its token.'),
  password: z.string().min(8, 'Use at least 8 characters for the new password.').max(200),
});
