import { prisma } from '../../shared/database/prisma.js';
import { badRequest, conflict, notFound } from '../../shared/errors/http-error.js';
import { env, isWalletTopupEnabled } from '../../shared/config/env.js';
import { emitNotificationEvent } from '../../shared/events/notification-events.js';
import { createRazorpayOrder, fetchRazorpayPayment, verifyRazorpaySignature, type RazorpayPaymentLike } from '../checkout/payment.service.js';
import { creditWallet } from './wallet.service.js';
import type { CreateTopupInput, VerifyTopupInput } from './wallet.schema.js';

/** Look up the exchange rate for a currency (minor units per 1 USD cent). Falls back to 1 for USD. */
async function getRateForCurrency(currencyCode: string): Promise<number> {
  if (currencyCode === 'USD') return 1;
  const cfg = await prisma.currencyConfig.findFirst({
    where: { settingsId: 'singleton', code: currencyCode, enabled: true },
    select: { rate: true },
  });
  if (!cfg || !Number.isFinite(cfg.rate) || cfg.rate <= 0) {
    throw badRequest(`Currency ${currencyCode} is not available for wallet top-up.`, [{ path: 'currency', message: 'Not available.' }]);
  }
  return cfg.rate;
}

/** Injectable payment fetch so the amount check is unit-testable with a mock. */
export interface TopupDeps {
  fetchPayment?: (razorpayPaymentId: string) => Promise<RazorpayPaymentLike>;
}

const defaultFetchPayment = (razorpayPaymentId: string) => fetchRazorpayPayment(razorpayPaymentId);

/**
 * H2: verifies a Razorpay payment really captured the top-up's exact amount before
 * any credit. A signature alone only proves the payment belongs to the Razorpay
 * order — it says nothing about the amount captured or whether the capture succeeded.
 */
async function assertCapturedTopupPayment(
  topup: { amountMinor: number; currency: string },
  razorpayPaymentId: string,
  deps?: TopupDeps,
): Promise<void> {
  const fetchPayment = deps?.fetchPayment ?? defaultFetchPayment;
  const payment = await fetchPayment(razorpayPaymentId);
  if (payment.status !== 'captured') {
    throw badRequest('Top-up payment was not captured.', [{ path: 'razorpayPaymentId', message: `Payment status is '${payment.status}', not 'captured'.` }]);
  }
  if (payment.currency !== topup.currency) {
    throw badRequest('Top-up payment currency mismatch.', [{ path: 'razorpayPaymentId', message: `Expected ${topup.currency}, got ${payment.currency}.` }]);
  }
  if (payment.amount !== topup.amountMinor) {
    throw badRequest('Top-up payment amount does not match the requested top-up amount.', [{ path: 'razorpayPaymentId', message: `Expected ${topup.amountMinor}, got ${payment.amount}.` }]);
  }
}

/** Creates a Razorpay order for a wallet top-up. Only available if isWalletTopupEnabled. */
export async function initiateTopup(customerId: string, input: CreateTopupInput) {
  if (!isWalletTopupEnabled) {
    throw badRequest('Wallet top-up is not enabled.');
  }

  const { amountMinor, currency } = input;

  // Validate currency is available and get the rate for later USD conversion
  await getRateForCurrency(currency);

  // Convert to USD cents to check against min/max limits
  const rate = await getRateForCurrency(currency);
  const usdCents = Math.round(amountMinor / rate);
  if (usdCents < env.WALLET_TOPUP_MIN_CENTS) {
    throw badRequest(`Minimum top-up is $${(env.WALLET_TOPUP_MIN_CENTS / 100).toFixed(0)} USD equivalent.`, [{ path: 'amountMinor', message: 'Below minimum.' }]);
  }
  if (usdCents > env.WALLET_TOPUP_MAX_CENTS) {
    throw badRequest(`Maximum top-up is $${(env.WALLET_TOPUP_MAX_CENTS / 100).toFixed(0)} USD equivalent.`, [{ path: 'amountMinor', message: 'Above maximum.' }]);
  }

  // Create the Razorpay order in the customer's chosen currency
  const rzpOrder = await createRazorpayOrder(amountMinor, currency, `wallet-${customerId.slice(-8)}`);

  const topup = await prisma.walletTopup.create({
    data: {
      customerId,
      amountMinor,
      currency,
      razorpayOrderId: rzpOrder.id,
      status: 'pending',
    },
  });

  return {
    topupId: topup.id,
    razorpayOrderId: rzpOrder.id,
    razorpayKeyId: env.RAZORPAY_KEY_ID ?? '',
    amountMinor,
    currency,
  };
}

/** Verifies the Razorpay signature and credits the wallet. Idempotent: a second call returns the same balance. */
export async function verifyTopup(customerId: string, input: VerifyTopupInput, deps?: TopupDeps) {
  const topup = await prisma.walletTopup.findUnique({ where: { id: input.topupId } });
  if (!topup) throw notFound('Top-up not found.');
  if (topup.customerId !== customerId) throw notFound('Top-up not found.');

  // Idempotent: already paid
  if (topup.status === 'paid') {
    const bal = await prisma.walletBalance.findUnique({ where: { customerId } });
    return { alreadyCredited: true, balanceMinor: bal?.balanceMinor ?? 0 };
  }
  // Reachable: the wallet webhook marks a top-up 'failed' on payment.failed (see
  // markTopupFailed). A failed top-up must never be credited by a later verify call.
  if (topup.status === 'failed') throw conflict('This top-up has been marked as failed.');

  verifyRazorpaySignature(topup.razorpayOrderId, input.razorpayPaymentId, input.razorpaySignature);
  await assertCapturedTopupPayment(topup, input.razorpayPaymentId, deps);

  const reference = `topup:${topup.id}`;

  // Check for existing ledger entry (extra idempotency guard)
  const existing = await prisma.walletTransaction.findUnique({ where: { reference } });
  if (existing) {
    // Already credited somehow; mark paid if not already
    await prisma.walletTopup.update({
      where: { id: topup.id },
      data: { status: 'paid', razorpayPaymentId: input.razorpayPaymentId },
    });
    return { alreadyCredited: true, balanceMinor: existing.balanceAfter };
  }

  // Convert display-currency amount to USD cents before crediting the wallet
  const rate = await getRateForCurrency(topup.currency);
  const usdCentsToCredit = Math.round(topup.amountMinor / rate);

  // Mark topup as paid and credit wallet in one transaction
  const { newBalance, txId } = await prisma.$transaction(async (tx) => {
    await tx.walletTopup.update({
      where: { id: topup.id },
      data: { status: 'paid', razorpayPaymentId: input.razorpayPaymentId },
    });
    return creditWallet(customerId, usdCentsToCredit, 'topup', reference, { topupId: topup.id, tx });
  });

  void emitNotificationEvent({
    type: 'wallet.topped_up',
    customerId,
    amountMinor: usdCentsToCredit,
    walletTxId: txId,
    newBalanceMinor: newBalance,
  });

  return { alreadyCredited: false, balanceMinor: newBalance };
}

/**
 * Marks a top-up 'failed' when Razorpay reports payment.failed. Only a 'pending'
 * top-up can be failed — an already-paid top-up keeps its credit (the failure
 * belongs to a different, later attempt). Returns whether the row was marked.
 */
export async function markTopupFailed(razorpayOrderId: string, razorpayPaymentId?: string): Promise<{ status: 'failed' | 'already_credited' | 'unknown_order' }> {
  const updated = await prisma.walletTopup.updateMany({
    where: { razorpayOrderId, status: 'pending' },
    data: { status: 'failed', ...(razorpayPaymentId ? { razorpayPaymentId } : {}) },
  });
  if (updated.count > 0) return { status: 'failed' };
  const topup = await prisma.walletTopup.findUnique({ where: { razorpayOrderId } });
  if (!topup) return { status: 'unknown_order' };
  return { status: 'already_credited' };
}

/** Verifies and credits a wallet topup after a Razorpay webhook event. Idempotent. */
export async function handleTopupWebhook(razorpayOrderId: string, razorpayPaymentId: string, deps?: TopupDeps) {
  const topup = await prisma.walletTopup.findUnique({ where: { razorpayOrderId } });
  if (!topup) return { status: 'unknown_order' };
  if (topup.status === 'paid') return { status: 'already_credited' };
  if (topup.status === 'failed') return { status: 'failed' };

  // H2: the webhook must verify the captured amount too — a payment.captured for a
  // different amount (or a forged/edited payload past signature checks) must never
  // credit the wallet.
  await assertCapturedTopupPayment(topup, razorpayPaymentId, deps);

  const reference = `topup:${topup.id}`;
  const existing = await prisma.walletTransaction.findUnique({ where: { reference } });
  if (existing) {
    await prisma.walletTopup.update({
      where: { id: topup.id },
      data: { status: 'paid', razorpayPaymentId },
    });
    return { status: 'already_credited' };
  }

  // Credit wallet and mark paid in a single transaction
  // Convert display-currency amount to USD cents before crediting the wallet
  const rate = await getRateForCurrency(topup.currency);
  const usdCentsToCredit = Math.round(topup.amountMinor / rate);

  const { newBalance, txId } = await prisma.$transaction(async (tx) => {
    await tx.walletTopup.update({ where: { id: topup.id }, data: { status: 'paid', razorpayPaymentId } });
    return creditWallet(topup.customerId, usdCentsToCredit, 'topup', reference, { topupId: topup.id, tx });
  });

  void emitNotificationEvent({
    type: 'wallet.topped_up',
    customerId: topup.customerId,
    amountMinor: usdCentsToCredit,
    walletTxId: txId,
    newBalanceMinor: newBalance,
  });

  return { status: 'credited', newBalance };
}
