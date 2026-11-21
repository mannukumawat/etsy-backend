import { z } from 'zod';

export const createTopupSchema = z.object({
  amountMinor: z.number().int('Must be an integer.').positive('Amount must be positive.'),
  currency: z.string().length(3, 'Must be a 3-letter ISO 4217 code.').toUpperCase(),
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

/** M-O7: owner wallet adjustment (credit/debit with a reason). This is an admin ledger
 *  action, NOT a Razorpay top-up: no money moves through a gateway, the balance is
 *  adjusted directly and the row is recorded with an `admin-adjust:` reference + note
 *  so it is auditable in the transaction history. */
export const adminWalletAdjustSchema = z.object({
  direction: z.enum(['credit', 'debit']),
  amountMinor: z.number().int('Must be an integer.').positive('Amount must be positive.').max(100_000_000),
  note: z.string().trim().min(3, 'Add a short reason (at least 3 characters).').max(300),
});
export type AdminWalletAdjustInput = z.infer<typeof adminWalletAdjustSchema>;
