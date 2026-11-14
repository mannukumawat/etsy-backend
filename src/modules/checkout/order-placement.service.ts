import { prisma } from '../../shared/database/prisma.js';
import { badRequest, conflict } from '../../shared/errors/http-error.js';
import { buildRateSnapshot } from '../../shared/utils/currency.js';
import { guestTokenExpiry, hashGuestToken, newGuestToken } from '../orders/order-guest-token.service.js';
import { ORDER_INCLUDE } from '../orders/order.mapper.js';
import type { PlaceOrderInput } from './checkout.schema.js';
import { computePreview, customerKeyFor } from './checkout.service.js';
import type { PlaceOrderResult } from './checkout.types.js';
import { assertPaymentMethodAvailable, initialPaymentStatus } from './payment.service.js';

/**
 * Places a real order from a cart: runs the same server-side pricing pipeline as the totals preview,
 * then writes the order, decrements stock and counts the coupon use in ONE transaction. Idempotent: a
 * repeated `idempotencyKey` returns the original order untouched.
 */
export async function placeOrder(input: PlaceOrderInput, customerId: string | null): Promise<PlaceOrderResult> {
  assertPaymentMethodAvailable(input.paymentMethod);

  const customerKey = customerKeyFor({ customerId, email: input.email });

  // Idempotent retry: the same key returns the original order untouched.
  const already = await prisma.order.findUnique({ where: { idempotencyKey: input.idempotencyKey }, include: ORDER_INCLUDE });
  if (already) return { replayed: true, order: already };

  const { context, resolved, stockIssues, quote, taxRate, totals, couponError, coupon } = await computePreview(
    { lines: input.lines, currency: input.currency, country: input.address.country, shippingMethodId: input.shippingMethodId, couponCode: input.couponCode },
    customerKey,
  );

  if (stockIssues.length) {
    throw conflict('Some items in your cart no longer have enough stock.', stockIssues.map((s) => ({ path: 'lines', message: `Only ${s.available} left of ${s.requested} requested.` })));
  }
  if (!quote) throw badRequest('We do not ship to this destination yet.', [{ path: 'address.country', message: 'Unsupported destination.' }]);
  if (input.couponCode && couponError) throw badRequest(couponError, [{ path: 'couponCode', message: couponError }]);

  const rateSnapshot = buildRateSnapshot(context.allCurrencies);

  // Guest orders get a one-time, high-entropy access token (returned once, by the caller) that stands in
  // for the session an account order already has — see order-tracking.service.ts for how it's used. Only
  // the hash is ever stored; the raw value exists only in this request and the one response.
  const guestToken = customerId ? null : newGuestToken();

  const placeInTransaction = () => prisma.$transaction(async (tx) => {
    // Conditional decrement: only succeeds if stock is still at least the requested quantity, so a
    // concurrent order for the same variant can never oversell it, even if both passed the earlier
    // read-only stock check at the same moment.
    for (const line of resolved) {
      const result = await tx.productVariant.updateMany({ where: { id: line.variantId, stock: { gte: line.quantity } }, data: { stock: { decrement: line.quantity } } });
      if (result.count === 0) throw conflict('Some items in your cart no longer have enough stock. Please review your cart and try again.');
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
        paymentMethod: input.paymentMethod,
        paymentStatus: initialPaymentStatus(input.paymentMethod),
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
      await tx.couponRedemption.create({ data: { couponId: appliedCoupon.id, customerKey, orderId: created.id } });
    }

    return created;
  });

  // A concurrent checkout can claim the same next order number between our read and insert; the
  // whole transaction (stock decrement and coupon increment included) rolls back, so retrying is safe.
  const isOrderNumberClash = (e: unknown) => {
    const err = e as { code?: string; meta?: { target?: unknown } };
    return err?.code === 'P2002' && String(err.meta?.target ?? '').includes('number');
  };
  let order: Awaited<ReturnType<typeof placeInTransaction>>;
  for (let attempt = 1; ; attempt++) {
    try {
      order = await placeInTransaction();
      break;
    } catch (e) {
      if (attempt < 3 && isOrderNumberClash(e)) continue;
      throw e;
    }
  }

  return { replayed: false, order, guestToken };
}
