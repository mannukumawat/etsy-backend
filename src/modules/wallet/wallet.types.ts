/** Wallet feature shared TypeScript types. */

export interface WalletBalanceDto {
  customerId: string;
  balancePaise: number;
  updatedAt: Date;
}

export interface WalletTransactionDto {
  id: string;
  customerId: string;
  type: 'topup' | 'spend' | 'refund' | 'reversal';
  amountPaise: number;
  balanceAfter: number;
  reference: string;
  orderId: string | null;
  topupId: string | null;
  note: string | null;
  createdAt: Date;
}

export interface WalletTopupDto {
  id: string;
  customerId: string;
  amountPaise: number;
  razorpayOrderId: string;
  razorpayPaymentId: string | null;
  status: 'pending' | 'paid' | 'failed';
  createdAt: Date;
  updatedAt: Date;
}

/** Shape returned by the wallet balance + preview in checkout. */
export interface WalletPreview {
  balancePaise: number;
  /** Max wallet amount applicable to the current order (min of balance and order total). */
  maxApplicablePaise: number;
}
