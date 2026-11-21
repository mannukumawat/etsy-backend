import { badRequest } from '../../shared/errors/http-error.js';

/**
 * Pure split-wallet arithmetic for checkout — no DB, no gateway, so it is unit-testable
 * in isolation. The caller must still validate the partial against the customer's real
 * wallet balance (debitWallet enforces sufficiency atomically inside the transaction).
 *
 * - partial <= 0 → no split: Razorpay charges the full total.
 * - 0 < partial < total → split: wallet is debited `partial`, Razorpay charges `total - partial`.
 * - partial === total → full wallet: nothing is charged to Razorpay.
 * - partial > total → rejected: the wallet leg can never exceed the order total.
 */
export function splitWalletPayment(totalPaise: number, walletPartialPaise: number): {
  walletPaise: number;
  razorpayPaise: number;
  isFullWallet: boolean;
  isSplitWallet: boolean;
} {
  const partial = Math.trunc(walletPartialPaise ?? 0);
  if (partial < 0) throw badRequest('Wallet amount cannot be negative.', [{ path: 'walletPartialPaise', message: 'Must be 0 or more.' }]);
  if (partial > totalPaise) {
    throw badRequest('Wallet amount cannot exceed the order total.', [{ path: 'walletPartialPaise', message: 'Exceeds the order total.' }]);
  }
  if (partial === 0) return { walletPaise: 0, razorpayPaise: totalPaise, isFullWallet: false, isSplitWallet: false };
  if (partial === totalPaise) return { walletPaise: totalPaise, razorpayPaise: 0, isFullWallet: true, isSplitWallet: false };
  return { walletPaise: partial, razorpayPaise: totalPaise - partial, isFullWallet: false, isSplitWallet: true };
}
