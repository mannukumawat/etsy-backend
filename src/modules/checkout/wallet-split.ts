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
export function splitWalletPayment(totalMinor: number, walletPartialMinor: number): {
  walletMinor: number;
  razorpayMinor: number;
  isFullWallet: boolean;
  isSplitWallet: boolean;
} {
  const partial = Math.trunc(walletPartialMinor ?? 0);
  if (partial < 0) throw badRequest('Wallet amount cannot be negative.', [{ path: 'walletPartialMinor', message: 'Must be 0 or more.' }]);
  if (partial > totalMinor) {
    throw badRequest('Wallet amount cannot exceed the order total.', [{ path: 'walletPartialMinor', message: 'Exceeds the order total.' }]);
  }
  if (partial === 0) return { walletMinor: 0, razorpayMinor: totalMinor, isFullWallet: false, isSplitWallet: false };
  if (partial === totalMinor) return { walletMinor: totalMinor, razorpayMinor: 0, isFullWallet: true, isSplitWallet: false };
  return { walletMinor: partial, razorpayMinor: totalMinor - partial, isFullWallet: false, isSplitWallet: true };
}
