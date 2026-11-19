import { z } from 'zod';

export const createTopupSchema = z.object({
  amountPaise: z.number().int('Must be an integer.').positive('Amount must be positive.'),
});
export type CreateTopupInput = z.infer<typeof createTopupSchema>;

export const verifyTopupSchema = z.object({
  topupId: z.string().min(1),
  razorpayPaymentId: z.string().min(1),
  razorpaySignature: z.string().min(1),
});
export type VerifyTopupInput = z.infer<typeof verifyTopupSchema>;

export const walletTxListSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type WalletTxListInput = z.infer<typeof walletTxListSchema>;
