import { z } from 'zod';

export const addBankAccountSchema = z.object({
  accountHolderName: z.string().min(1).max(255),
  accountNumber: z.string().regex(/^\d{9,18}$/, 'Account number must be 9–18 digits.'),
  accountNumberConfirm: z.string(),
  ifscCode: z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Invalid IFSC code.'),
}).refine(d => d.accountNumber === d.accountNumberConfirm, {
  message: 'Account numbers do not match.',
  path: ['accountNumberConfirm'],
});

export type AddBankAccountInput = z.infer<typeof addBankAccountSchema>;
