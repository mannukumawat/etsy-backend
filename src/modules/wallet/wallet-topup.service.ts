import { prisma } from '../../shared/database/prisma.js';
import { badRequest, conflict, notFound } from '../../shared/errors/http-error.js';
import { env, isWalletTopupEnabled } from '../../shared/config/env.js';
import { emitNotificationEvent } from '../../shared/events/notification-events.js';
import { createRazorpayOrder, fetchRazorpayPayment, verifyRazorpaySignature, type RazorpayPaymentLike } from '../checkout/payment.service.js';
import { creditWallet } from './wallet.service.js';
import type { CreateTopupInput, VerifyTopupInput } from './wallet.schema.js';

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
  topup: { amountPaise: number },
  razorpayPaymentId: string,
  deps?: TopupDeps,
): Promise<void> {
  const fetchPayment = deps?.fetchPayment ?? defaultFetchPayment;
  const payment = await fetchPayment(razorpayPaymentId);
  if (payment.status !== 'captured') {
    throw badRequest('Top-up payment was not captured.', [{ path: 'razorpayPaymentId', message: `Payment status is '${payment.status}', not 'captured'.` }]);
  }
  if (payment.currency !== 'INR') {
    throw badRequest('Top-up payment currency mismatch.', [{ path: 'razorpayPaymentId', message: `Expected INR, got ${payment.currency}.` }]);
  }
  if (payment.amount !== topup.amountPaise) {
    throw badRequest('Top-up payment amount does not match the requested top-up amount.', [{ path: 'razorpayPaymentId', message: `Expected ${topup.amountPaise}, got ${payment.amount}.` }]);
  }
}

/** Creates a Razorpay order for a wallet top-up. Only available if isWalletTopupEnabled. */
export async function initiateTopup(customerId: string, input: CreateTopupInput) {
  if (!isWalletTopupEnabled) {
    throw badRequest('Wallet top-up is not enabled.');
  }

  const { amountPaise } = input;
  if (amountPaise < env.WALLET_TOPUP_MIN_PAISE) {
    throw badRequest(`Minimum top-up amount is ₹${(env.WALLET_TOPUP_MIN_PAISE / 100).toFixed(0)}.`, [{ path: 'amountPaise', message: 'Below minimum.' }]);
  }
  if (amountPaise > env.WALLET_TOPUP_MAX_PAISE) {
    throw badRequest(`Maximum top-up amount is ₹${(env.WALLET_TOPUP_MAX_PAISE / 100).toFixed(0)}.`, [{ path: 'amountPaise', message: 'Above maximum.' }]);
  }

  // Create the Razorpay order first so we have an order ID for the receipt
  const rzpOrder = await createRazorpayOrder(amountPaise, 'INR', `wallet-${customerId.slice(-8)}`);

  const topup = await prisma.walletTopup.create({
    data: {
      customerId,
      amountPaise,
      razorpayOrderId: rzpOrder.id,
      status: 'pending',
    },
  });

  return {
    topupId: topup.id,
    razorpayOrderId: rzpOrder.id,
    razorpayKeyId: env.RAZORPAY_KEY_ID ?? '',
    amountPaise,
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
    return { alreadyCredited: true, balancePaise: bal?.balancePaise ?? 0 };
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
    return { alreadyCredited: true, balancePaise: existing.balanceAfter };
  }

  // Mark topup as paid and credit wallet in one transaction
  const { newBalance, txId } = await prisma.$transaction(async (tx) => {
    await tx.walletTopup.update({
      where: { id: topup.id },
      data: { status: 'paid', razorpayPaymentId: input.razorpayPaymentId },
    });
    return creditWallet(customerId, topup.amountPaise, 'topup', reference, { topupId: topup.id, tx });
  });

  void emitNotificationEvent({
    type: 'wallet.topped_up',
    customerId,
    amountPaise: topup.amountPaise,
    walletTxId: txId,
    newBalancePaise: newBalance,
  });

  return { alreadyCredited: false, balancePaise: newBalance };
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
  const { newBalance, txId } = await prisma.$transaction(async (tx) => {
    await tx.walletTopup.update({ where: { id: topup.id }, data: { status: 'paid', razorpayPaymentId } });
    return creditWallet(topup.customerId, topup.amountPaise, 'topup', reference, { topupId: topup.id, tx });
  });

  void emitNotificationEvent({
    type: 'wallet.topped_up',
    customerId: topup.customerId,
    amountPaise: topup.amountPaise,
    walletTxId: txId,
    newBalancePaise: newBalance,
  });

  return { status: 'credited', newBalance };
}
