import { prisma } from '../../shared/database/prisma.js';
import { badRequest, conflict, HttpError } from '../../shared/errors/http-error.js';
import { emitNotificationEvent } from '../../shared/events/notification-events.js';
import { buildRateSnapshot, convertFromBase } from '../../shared/utils/currency.js';
import { adjustmentData } from '../../shared/utils/inventory-adjustments.js';
import { emitLowStockIfCrossed } from '../inventory/low-stock-alert.js';
import { guestTokenExpiry, hashGuestToken, newGuestToken } from '../orders/order-guest-token.service.js';
import { ORDER_INCLUDE } from '../orders/order.mapper.js';
import type { PlaceOrderInput } from './checkout.schema.js';
import { computePreview, customerKeyFor } from './checkout.service.js';
import {
  isCouponRedemptionClash,
  isIdempotencyKeyClash,
  isOrderNumberClash,
  isPaymentReferenceClash,
  replayOwnershipMatches,
  replayPayloadMatches,
  type ReplayOrderLike,
  type ReplayRequestLike,
} from './idempotency.js';
import type { PlaceOrderResult } from './checkout.types.js';
import {
  assertPaymentMethodAvailable,
  assertPaymentMethodForCountry,
  initialPaymentStatus,
  verifyCapturedPayment,
  verifyRazorpayOrderAmount,
  verifyRazorpaySignature,
  type PaymentMethod,
} from './payment.service.js';
import { debitWallet, getBalance } from '../wallet/wallet.service.js';
import { splitWalletPayment } from './wallet-split.js';
import { recordCapturedPayment } from './payment-recovery.service.js';
import { consumeHolds } from './stock-hold.service.js';

/**
 * Places a real order from a cart: runs the same server-side pricing pipeline as the totals preview,
 * then writes the order, decrements stock and counts the coupon use in ONE transaction. Idempotent: a
 * repeated `idempotencyKey` returns the original order untouched.
 *
 * Replay order (H1a): the idempotency lookup runs BEFORE any Razorpay-proof
 * requirement, so a retry that lost the Razorpay fields returns the original order
 * instead of throwing "Payment details missing". A replay is only ever returned
 * after an ownership + payload check (H1c) — see assertReplay below.
 */
export async function placeOrder(input: PlaceOrderInput, customerId: string | null): Promise<PlaceOrderResult> {
  const walletAmountMinor = input.walletAmountMinor ?? 0;
  const walletPartialMinor = input.walletPartialMinor ?? 0;
  const isFullWalletPayment = walletAmountMinor > 0 && input.paymentMethod === 'wallet';
  const hasPartialWallet = walletPartialMinor > 0;

  // Country-specific payments: UPI is India-only (enforced here and in create-order).
  assertPaymentMethodForCountry(input.paymentMethod, input.address.country);

  if (walletAmountMinor > 0 && input.paymentMethod !== 'wallet') {
    throw badRequest('walletAmountMinor is only for a full wallet payment. Use walletPartialMinor for a split wallet + card/UPI payment.', [{ path: 'walletAmountMinor', message: 'Not valid with this payment method.' }]);
  }

  if (isFullWalletPayment) {
    // Wallet payment: must be signed-in customer
    if (!customerId) {
      throw badRequest('You must be signed in to pay with your wallet.', [{ path: 'paymentMethod', message: 'Sign in required.' }]);
    }
  } else if (hasPartialWallet) {
    // Split wallet + Razorpay: wallet debit needs a signed-in customer. Razorpay proof is
    // required unless the partial covers the whole total — that is only knowable after the
    // authoritative total is computed, so a missing proof is checked there, not here.
    if (!customerId) {
      throw badRequest('You must be signed in to pay with your wallet.', [{ path: 'walletPartialMinor', message: 'Sign in required.' }]);
    }
  }

  const customerKey = customerKeyFor({ customerId, email: input.email });
  const replayRequest: ReplayRequestLike = {
    customerId,
    email: input.email,
    currency: input.currency,
    lines: input.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
    razorpayPaymentId: input.razorpayPaymentId ?? null,
  };

  // Idempotent retry (pre-check, BEFORE any Razorpay-proof requirement): the same
  // key returns the original order untouched — but only to its owner, and only
  // when the payload matches (H1a + H1c). The in-transaction check below re-verifies
  // with the authoritative total, so a race between the two checks cannot slip a
  // different cart through.
  const already = await prisma.order.findUnique({ where: { idempotencyKey: input.idempotencyKey }, include: ORDER_INCLUDE });
  if (already) {
    assertReplay(already, replayRequest);
    return { replayed: true, order: already };
  }

  // Razorpay proof: required for every non-full-wallet order. (A full-wallet order
  // presents no Razorpay fields at all; a split order's proof is checked again
  // after the authoritative total is known, below.)
  if (!isFullWalletPayment) {
    assertPaymentMethodAvailable(input.paymentMethod);
    if (hasPartialWallet) {
      if (input.razorpayOrderId || input.razorpayPaymentId || input.razorpaySignature) {
        if (!input.razorpayOrderId || !input.razorpayPaymentId || !input.razorpaySignature) {
          throw badRequest('Incomplete Razorpay payment details.', [{ path: 'razorpayPaymentId', message: 'Razorpay payment details required.' }]);
        }
        verifyRazorpaySignature(input.razorpayOrderId, input.razorpayPaymentId, input.razorpaySignature);
      }
    } else {
      if (!input.razorpayOrderId || !input.razorpayPaymentId || !input.razorpaySignature) {
        throw badRequest('Payment details missing.', [{ path: 'razorpayPaymentId', message: 'Razorpay payment details required.' }]);
      }
      verifyRazorpaySignature(input.razorpayOrderId, input.razorpayPaymentId, input.razorpaySignature);
    }
  }

  const { context, resolved, stockIssues, quote, taxRate, totals, couponError, coupon } = await computePreview(
    { lines: input.lines, currency: input.currency, country: input.address.country, region: input.address.region, shippingMethodId: input.shippingMethodId, couponCode: input.couponCode },
    customerKey,
  );

  if (stockIssues.length) {
    throw conflict('Some items in your cart no longer have enough stock.', stockIssues.map((s) => ({ path: 'lines', message: `Only ${s.available} left of ${s.requested} requested.` })));
  }
  if (!quote) throw badRequest('We do not ship to this destination yet.', [{ path: 'address.country', message: 'Unsupported destination.' }]);
  if (input.couponCode && couponError) throw badRequest(couponError, [{ path: 'couponCode', message: couponError }]);

  // Split-wallet resolution against the authoritative total. splitWalletPayment rejects a
  // partial above the total; a partial equal to the total is a full-wallet order.
  const split = splitWalletPayment(totals.total, walletPartialMinor);
  const isSplitWallet = split.isSplitWallet;
  const isFullWallet = isFullWalletPayment || split.isFullWallet;

  if (isFullWallet && hasPartialWallet && input.razorpayPaymentId) {
    // Contradictory request: the wallet already covers the whole total, yet a Razorpay
    // payment is also presented. Accepting it would charge the customer twice, so reject.
    throw badRequest('Wallet payment already covers the order total. Do not include Razorpay payment details.', [{ path: 'walletPartialMinor', message: 'Covers the full total.' }]);
  }

  // M2: when the wallet covers the full total (including via a partial equal to the
  // total), the stored payment method is 'wallet' — never the client-supplied
  // 'card'/'upi', which would mislabel a 100%-wallet order.
  const storedPaymentMethod: PaymentMethod = isFullWallet ? 'wallet' : input.paymentMethod;

  if (!isFullWallet) {
    // Razorpay proof is required for every non-full-wallet order (including split-wallet).
    assertPaymentMethodAvailable(input.paymentMethod);
    if (!input.razorpayOrderId || !input.razorpayPaymentId || !input.razorpaySignature) {
      throw badRequest('Payment details missing.', [{ path: 'razorpayPaymentId', message: 'Razorpay payment details required.' }]);
    }
    // After computing the authoritative total, verify the Razorpay order was created for
    // exactly the REMAINDER (total - wallet partial) and currency. Prevents a tampered flow
    // where a cheap external order is substituted — and, for split payments, prevents the
    // original overcharge where Razorpay was created for the full total.
    await verifyRazorpayOrderAmount(input.razorpayOrderId, split.razorpayMinor, input.currency);
    // H3: verify the CAPTURE itself — status 'captured' and amount/currency matching
    // the remainder. The order-amount check above cannot prove money moved.
    await verifyCapturedPayment(input.razorpayPaymentId, split.razorpayMinor, input.currency);
  }

  // Wallet amount validation — wallet is in USD cents, order totals in display currency.
  // Convert between the two using the pricing context's exchange rate.
  if (walletAmountMinor > 0) {
    // Full-wallet payment must equal the total exactly — neither under- nor over-payment.
    if (walletAmountMinor !== totals.total) {
      throw badRequest(
        'Full wallet payment must equal the order total.',
        [{ path: 'walletAmountMinor', message: 'Must equal the full order total.' }],
      );
    }
  }
  if (hasPartialWallet) {
    // Validate against the customer's ACTUAL wallet balance from the DB — never trust the
    // client-sent amount. The debit inside the transaction re-checks atomically, so a
    // concurrent spend between this read and the debit still cannot overdraw.
    const balanceUsdCents = await getBalance(customerId!);
    // Convert wallet balance from USD cents to display currency for comparison
    const balanceDisplayMinor = convertFromBase(balanceUsdCents, context.currency);
    if (walletPartialMinor > balanceDisplayMinor) {
      throw badRequest(
        'Insufficient wallet balance.',
        [{ path: 'walletPartialMinor', message: 'Exceeds wallet balance.' }],
      );
    }
  }

  // Amount debited from the wallet inside the transaction (in display currency minor units).
  // Will be converted to USD cents before the actual DB debit.
  const walletDebitDisplayMinor = isFullWallet ? totals.total : isSplitWallet ? split.walletMinor : 0;
  // Convert display minor → USD cents for the wallet debit
  const walletDebitUsdCents = walletDebitDisplayMinor > 0 ? Math.round(walletDebitDisplayMinor / context.currency.rate) : 0;

  const rateSnapshot = buildRateSnapshot(context.allCurrencies);

  // Guest orders get a one-time, high-entropy access token (returned once, by the caller) that stands in
  // for the session an account order already has — see order-tracking.service.ts for how it's used. Only
  // the hash is ever stored; the raw value exists only in this request and the one response.
  const guestToken = customerId ? null : newGuestToken();

  const placeInTransaction = () => prisma.$transaction(async (tx) => {
    // M-I6: the replay check runs INSIDE the transaction, not just before it.
    // The pre-check above is only a fast path: two concurrent requests with the same
    // key can both pass it, and the old code would then decrement stock twice and
    // create two orders. Now the first transaction to insert wins; the second either
    // sees the row here or hits the idempotencyKey unique constraint (handled in the
    // retry loop below) and replays the original order instead of charging twice.
    // (Commit f39689a claimed this fix but changed nothing here — verified by diff;
    // this is the real fix.)
    const existing = await tx.order.findUnique({ where: { idempotencyKey: input.idempotencyKey }, include: ORDER_INCLUDE });
    if (existing) {
      // Re-check ownership + payload with the authoritative total now known.
      assertReplay(existing, { ...replayRequest, total: totals.total });
      return { replayed: true as const, order: existing, walletTxId: null as string | null, decrements: [] as Array<{ line: (typeof resolved)[number]; after: number }> };
    }

    // Conditional decrement: only succeeds if stock is still at least the requested quantity, so a
    // concurrent order for the same variant can never oversell it, even if both passed the earlier
    // read-only stock check at the same moment. The post-decrement read gives the exact `after`
    // for the stock-history row (H2) — `before` is then `after + quantity`, never a stale preview read.
    const decrements: Array<{ line: (typeof resolved)[number]; after: number }> = [];
    for (const line of resolved) {
      const result = await tx.productVariant.updateMany({ where: { id: line.variantId, stock: { gte: line.quantity } }, data: { stock: { decrement: line.quantity } } });
      if (result.count === 0) throw conflict('Some items in your cart no longer have enough stock. Please review your cart and try again.');
      const afterRow = await tx.productVariant.findUnique({ where: { id: line.variantId }, select: { stock: true } });
      if (!afterRow) throw conflict('Some items in your cart no longer have enough stock. Please review your cart and try again.');
      decrements.push({ line, after: afterRow.stock });
    }

    let appliedCoupon: typeof coupon = null;
    if (coupon && !couponError) {
      const limitClause = coupon.usageLimit != null ? { timesUsed: { lt: coupon.usageLimit } } : {};
      const result = await tx.coupon.updateMany({ where: { id: coupon.id, ...limitClause }, data: { timesUsed: { increment: 1 } } });
      if (result.count === 0) throw conflict('This coupon just reached its usage limit. Remove it and try again.');
      appliedCoupon = coupon;
    }

    // Next number = highest existing + 1, not 240501 + row count: a count collides with an existing
    // number as soon as any order row is ever deleted. String ordering is numeric here because every
    // number is "YS-" + six digits (until YS-999999). Two checkouts racing for the same number are
    // handled by the retry loop around this transaction.
    const last = await tx.order.findFirst({ where: { number: { startsWith: 'YS-' } }, orderBy: { number: 'desc' }, select: { number: true } });
    const lastSeq = last ? Number.parseInt(last.number.replace(/^YS-/, ''), 10) : Number.NaN;
    const number = `YS-${Number.isFinite(lastSeq) ? lastSeq + 1 : 240501}`;

    const created = await tx.order.create({
      data: {
        number,
        idempotencyKey: input.idempotencyKey,
        customerId,
        customerKind: customerId ? 'account' : 'guest',
        customerName: input.address.fullName,
        customerEmail: input.email.trim().toLowerCase(),
        customerPhone: input.address.phone,
        guestTokenHash: guestToken ? hashGuestToken(guestToken) : null,
        guestTokenExpiresAt: guestToken ? guestTokenExpiry() : null,
        shippingAddressJson: JSON.stringify(input.address),
        currency: context.currency.code,
        rateSnapshotJson: JSON.stringify(rateSnapshot),
        subtotal: totals.subtotal,
        discount: totals.discount,
        couponCode: appliedCoupon?.code ?? null,
        shipping: totals.shipping,
        tax: totals.tax,
        taxRate,
        taxInclusive: context.pricesIncludeTax,
        total: totals.total,
        shippingMethodId: input.shippingMethodId,
        shippingMethodLabel: quote.label,
        shippingMinDays: quote.minDays,
        shippingMaxDays: quote.maxDays,
        paymentMethod: storedPaymentMethod,
        // C2: the gateway ids are persisted, not discarded. paymentReference is the
        // Razorpay payment id — the refund/reconciliation key (@@unique, so one
        // payment can fund at most one order). Null for full-wallet orders, which
        // have no Razorpay payment; legacy "" values were migrated to NULL.
        razorpayOrderId: input.razorpayOrderId ?? null,
        paymentReference: input.razorpayPaymentId ?? null,
        paymentStatus: initialPaymentStatus(storedPaymentMethod),
        lines: {
          create: resolved.map((l) => ({
            productId: l.productId,
            variantId: l.variantId,
            slug: l.slug,
            sku: l.sku,
            nameEn: l.nameEn,
            nameHi: l.nameHi,
            variantLabelEn: l.variantLabelEn,
            variantLabelHi: l.variantLabelHi,
            imageUrl: l.imageUrl,
            unitPrice: l.unitPriceConverted,
            quantity: l.quantity,
            lineTotal: l.lineTotalConverted,
          })),
        },
        events: { create: [{ type: 'created', message: 'Order placed.', actor: 'customer' }] },
      },
      include: ORDER_INCLUDE,
    });

    if (appliedCoupon) {
      try {
        await tx.couponRedemption.create({ data: { couponId: appliedCoupon.id, customerKey, orderId: created.id } });
      } catch (e) {
        // The per-customer coupon limit is a unique constraint — a concurrent
        // redemption for the same customer is a 409 conflict, never a 500.
        if (isCouponRedemptionClash(e)) throw conflict('This coupon has already been used for this account.');
        throw e;
      }
    }

    // H5 + L4: consume the stock holds for this Razorpay order and mark the persisted
    // Razorpay order row 'paid', in the same transaction as the order itself. If the
    // holds already expired, this deletes nothing — placeOrder still succeeds via
    // the conditional stock decrement above; the hold was only a reservation.
    if (input.razorpayOrderId) {
      await consumeHolds(tx, input.razorpayOrderId);
      await tx.razorpayOrder.updateMany({ where: { razorpayOrderId: input.razorpayOrderId }, data: { status: 'paid' } });
    }

    // Stock-history rows for the sale (H2): one per line, in the same transaction as the
    // decrement and the order, so history can never miss a sale and "Last adjusted" stays true.
    if (decrements.length) {
      await tx.inventoryAdjustment.createMany({
        data: decrements.map(({ line, after }) =>
          adjustmentData({
            productId: line.productId,
            variantId: line.variantId,
            sku: line.sku,
            productNameEn: line.nameEn,
            productNameHi: line.nameHi,
            variantLabel: line.variantLabelEn,
            before: after + line.quantity,
            after,
            reason: 'sale',
            note: `Sold in order ${number}.`,
            actor: 'system',
          }),
        ),
      });
    }

    // Wallet debit (full wallet payment, or the wallet leg of a split payment) for
    // signed-in customers. Runs inside the same transaction as the order, and debitWallet
    // itself refuses to overdraw atomically — so a concurrent spend cannot overdraw either.
    // Wallet balance is in USD cents; walletDebitUsdCents is already converted.
    let walletTxId: string | null = null;
    let walletNewBalance: number | null = null;
    if (walletDebitUsdCents > 0 && customerId) {
      const walletRef = `spend:order:${created.id}`;
      const walletResult = await debitWallet(customerId, walletDebitUsdCents, 'spend', walletRef, { orderId: created.id, tx });
      walletTxId = walletResult.txId;
      walletNewBalance = walletResult.newBalance;
    }

    return { replayed: false as const, created, walletTxId, walletNewBalance, decrements };
  });

  // A concurrent checkout can claim the same next order number between our read and insert; the
  // whole transaction (stock decrement and coupon increment included) rolls back, so retrying is safe.
  // (M-I6: the idempotencyKey clash is a replay, not an error — see idempotency.ts.)
  let txResult: Awaited<ReturnType<typeof placeInTransaction>>;
  for (let attempt = 1; ; attempt++) {
    try {
      txResult = await placeInTransaction();
      break;
    } catch (e) {
      if (attempt < 3 && isOrderNumberClash(e)) continue;
      if (isIdempotencyKeyClash(e)) {
        const existing = await prisma.order.findUnique({ where: { idempotencyKey: input.idempotencyKey }, include: ORDER_INCLUDE });
        if (existing) {
          assertReplay(existing, { ...replayRequest, total: totals.total });
          return { replayed: true, order: existing };
        }
      }
      if (isPaymentReferenceClash(e)) {
        // C2: the same Razorpay payment id already funded an order. Replay it when
        // it is this requester's matching order; otherwise 409 — never a second
        // paid order for one payment.
        const existing = await prisma.order.findFirst({ where: { paymentReference: input.razorpayPaymentId ?? '' }, include: ORDER_INCLUDE });
        if (existing) {
          assertReplay(existing, { ...replayRequest, total: totals.total });
          return { replayed: true, order: existing };
        }
        throw conflict('This payment has already been used for another order.');
      }
      if (isWalletDebitFailureAfterPayment(e) && input.razorpayPaymentId) {
        // M3: the wallet debit failed AFTER the customer already paid Razorpay (the
        // balance changed between create-order and placeOrder). The order transaction
        // rolled back, so record the captured payment for reconciliation (the order
        // webhook is the second witness) and tell the customer exactly what happens
        // next instead of a bare 409.
        await recordCapturedPayment({
          razorpayPaymentId: input.razorpayPaymentId,
          razorpayOrderId: input.razorpayOrderId ?? '',
          amount: split.razorpayMinor,
          currency: input.currency,
          customerEmail: input.email.trim().toLowerCase(),
        }).catch(() => undefined);
        throw conflict(
          `Wallet balance changed after payment — your payment is recorded and will be reconciled, reference ${input.razorpayPaymentId}.`,
        );
      }
      throw e;
    }
  }

  if (txResult!.replayed) return { replayed: true, order: txResult!.order };

  const { created: order, walletTxId, decrements } = txResult!;

  // M-I5: a sale that pushes a variant down through the low-stock threshold alerts the owner.
  for (const d of decrements) void emitLowStockIfCrossed(d.line.variantId, d.after + d.line.quantity, d.after);

  // Emit after transaction commits — fire-and-forget, never fails the caller.
  void emitNotificationEvent({
    type: 'order.placed',
    orderId: order.id,
    orderNumber: order.number,
    customerId: customerId,
    customerEmail: order.customerEmail,
    totalMinor: order.total,
    currency: order.currency,
  });

  if (walletDebitUsdCents > 0 && customerId && walletTxId) {
    void emitNotificationEvent({
      type: 'wallet.spend',
      customerId,
      amountMinor: walletDebitUsdCents,
      walletTxId,
      orderId: order.id,
    });
  }

  return { replayed: false, order, guestToken };
}

/**
 * Ownership + payload gate for every replay path (H1c). Throws 409 on any mismatch —
 * the original order is never returned to the wrong requester or for a different cart.
 */
function assertReplay(order: ReplayOrderLike, req: ReplayRequestLike): void {
  if (!replayOwnershipMatches(order, req.customerId, req.email)) {
    throw conflict('This checkout was already submitted under a different account. Sign in with the account used for the original order.');
  }
  if (!replayPayloadMatches(order, req)) {
    throw conflict('This checkout was already submitted with different details. Start a new checkout instead of retrying.');
  }
}

/** True when the failure is debitWallet refusing an overdraw (balance spent concurrently). */
function isWalletDebitFailureAfterPayment(e: unknown): boolean {
  return e instanceof HttpError && e.status === 409 && e.message.includes('Insufficient wallet balance');
}
