import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { attachCustomer } from '../customerAuth.js';
import { prisma } from '../db.js';
import { badRequest, conflict, notFound, route } from '../http.js';
import { mediaUrl } from '../env.js';
import { toStorefrontOrder, toStorefrontOrderTrack, ORDER_INCLUDE } from '../mappers.js';
import { loadLineExtras } from '../orderLineExtras.js';
import { couponValidationLimiter, orderLookupLimiter } from '../rateLimit.js';
import {
  buildRateSnapshot,
  calculateTotals,
  convertFromBase,
  evaluateCoupon,
  getShippingQuote,
  getShippingQuotes,
  getTaxRate,
  type CartLineForCoupon,
} from '../pricing.js';
import { assertPaymentMethodAvailable, initialPaymentStatus } from '../payments.js';
import { checkoutTotalsSchema, orderTrackSchema, placeOrderSchema, validateCouponSchema, type CheckoutTotalsInput, type PlaceOrderInput } from '../validation.js';

const GUEST_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — long enough to revisit a confirmation page
const hashGuestToken = (raw: string) => createHash('sha256').update(raw).digest('hex');

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// Server-calculated checkout: the client never computes a total that is trusted. Both /totals (a
// preview, no side effects) and /orders (places a real order) run the exact same pricing pipeline in
// pricing.ts, so a preview and the order it leads to can never disagree.

export const checkoutRouter = Router();
export const orderTrackRouter = Router();
checkoutRouter.use(attachCustomer);

async function loadPricingContext(currencyCode: string) {
  const [allCurrencies, shipping, tax] = await Promise.all([
    prisma.currencyConfig.findMany({ where: { settingsId: 'singleton' } }),
    prisma.shippingSettings.findUniqueOrThrow({ where: { id: 'singleton' }, include: { zones: true } }),
    prisma.taxSettings.findUniqueOrThrow({ where: { id: 'singleton' }, include: { rules: true } }),
  ]);
  const currency = allCurrencies.find((c) => c.code === currencyCode && c.enabled);
  if (!currency) throw badRequest('That currency is not available.', [{ path: 'currency', message: 'Not available.' }]);
  return { currency, allCurrencies, zones: shipping.zones, taxRules: tax.rules, defaultTaxRate: tax.defaultRate, pricesIncludeTax: tax.pricesIncludeTax };
}

interface ResolvedLine {
  productId: string;
  variantId: string;
  categoryId: string;
  quantity: number;
  unitPriceConverted: number;
  lineTotalConverted: number;
  sku: string;
  nameEn: string;
  nameHi: string;
  slug: string;
  variantLabelEn: string;
  variantLabelHi: string;
  imageUrl: string;
  availableStock: number;
}

interface StockIssue {
  productId: string;
  variantId: string;
  requested: number;
  available: number;
}

async function resolveLines(
  lines: Array<{ productId: string; variantId: string; quantity: number }>,
  currency: { code: string; rate: number; fractionDigits: number; roundingIncrement: number },
): Promise<{ resolved: ResolvedLine[]; stockIssues: StockIssue[] }> {
  const variantIds = lines.map((l) => l.variantId);
  const variants = await prisma.productVariant.findMany({
    where: { id: { in: variantIds } },
    include: {
      product: {
        select: {
          id: true, slug: true, nameEn: true, nameHi: true, categoryId: true, status: true,
          category: { select: { isActive: true } },
          images: { orderBy: { position: 'asc' }, take: 1, select: { mediaId: true } },
          options: { include: { values: true } },
        },
      },
    },
  });

  const resolved: ResolvedLine[] = [];
  const stockIssues: StockIssue[] = [];

  for (const line of lines) {
    const variant = variants.find((v) => v.id === line.variantId && v.productId === line.productId);
    if (!variant || variant.product.status !== 'active' || !variant.product.category.isActive) {
      throw badRequest('One of the items in your cart is no longer available.', [{ path: 'lines', message: 'Unavailable.' }]);
    }
    if (variant.stock < line.quantity) {
      stockIssues.push({ productId: line.productId, variantId: line.variantId, requested: line.quantity, available: variant.stock });
    }
    const chosen = JSON.parse(variant.options || '{}') as Record<string, string>;
    const variantLabelEn = variant.product.options
      .map((o) => o.values.find((v) => v.id === chosen[o.id])?.labelEn)
      .filter((v): v is string => !!v)
      .join(' / ');
    const variantLabelHi = variant.product.options
      .map((o) => o.values.find((v) => v.id === chosen[o.id])?.labelHi)
      .filter((v): v is string => !!v)
      .join(' / ');
    const unitPriceConverted = convertFromBase(variant.price, currency);
    resolved.push({
      productId: variant.productId,
      variantId: variant.id,
      categoryId: variant.product.categoryId,
      quantity: line.quantity,
      unitPriceConverted,
      lineTotalConverted: unitPriceConverted * line.quantity,
      sku: variant.sku,
      nameEn: variant.product.nameEn,
      nameHi: variant.product.nameHi,
      slug: variant.product.slug,
      variantLabelEn,
      variantLabelHi,
      imageUrl: variant.product.images[0] ? mediaUrl(variant.product.images[0].mediaId) : '',
      availableStock: variant.stock,
    });
  }
  return { resolved, stockIssues };
}

async function computePreview(input: CheckoutTotalsInput, customerKey: string) {
  const context = await loadPricingContext(input.currency);
  const { resolved, stockIssues } = await resolveLines(input.lines, context.currency);

  const quote = getShippingQuote(context.zones, input.country, input.shippingMethodId, context.currency);
  const quotes = getShippingQuotes(context.zones, input.country, context.currency);

  let discount = 0;
  let couponError: string | null = null;
  let coupon: Awaited<ReturnType<typeof prisma.coupon.findUnique>> | null = null;
  if (input.couponCode) {
    coupon = await prisma.coupon.findUnique({ where: { code: input.couponCode.trim().toUpperCase() } });
    if (!coupon) couponError = 'This coupon code does not exist.';
    else {
      const priorUses = await prisma.couponRedemption.count({ where: { couponId: coupon.id, customerKey } });
      const cartLines: CartLineForCoupon[] = resolved.map((l) => ({ productId: l.productId, categoryId: l.categoryId, lineTotal: l.lineTotalConverted }));
      const evaluation = evaluateCoupon(coupon, cartLines, context.currency, new Date(), priorUses);
      if (!evaluation.ok) couponError = evaluation.error ?? 'This coupon cannot be applied.';
      else discount = evaluation.discount;
    }
  }

  const taxRate = getTaxRate(context.taxRules, context.defaultTaxRate, input.country, null);
  const totals = calculateTotals({
    lineTotals: resolved.map((l) => l.lineTotalConverted),
    discount,
    shipping: quote?.amount ?? 0,
    taxRate,
    taxInclusive: context.pricesIncludeTax,
  });

  return { context, resolved, stockIssues, quote, quotes, taxRate, totals, couponError, coupon };
}

checkoutRouter.post(
  '/totals',
  route(async (req, res) => {
    const input = checkoutTotalsSchema.parse(req.body);
    const customerKey = req.customer ? `acct:${req.customer.sub}` : `guest:${String(req.body?.email ?? '').trim().toLowerCase()}`;
    const { resolved, stockIssues, quote, quotes, taxRate, totals, couponError } = await computePreview(input, customerKey);

    res.json({
      lines: resolved.map((l) => ({ productId: l.productId, variantId: l.variantId, quantity: l.quantity, unitPrice: l.unitPriceConverted, lineTotal: l.lineTotalConverted })),
      shippingQuotes: quotes,
      shippingSupported: !!quote,
      taxRate,
      couponValid: !!input.couponCode && !couponError,
      couponError,
      stockIssues,
      totals,
    });
  }),
);

/** Lightweight coupon check for the bare cart page, which has no destination yet — validates the code,
 *  eligibility and minimum order against the cart contents only (no shipping/tax), returning the
 *  discount in the given currency. The authoritative check still happens again at /totals and /orders. */
checkoutRouter.post(
  '/validate-coupon',
  couponValidationLimiter,
  route(async (req, res) => {
    const input = validateCouponSchema.parse(req.body);
    const currency = await prisma.currencyConfig.findFirst({ where: { settingsId: 'singleton', code: input.currency, enabled: true } });
    if (!currency) throw badRequest('That currency is not available.', [{ path: 'currency', message: 'Not available.' }]);
    const { resolved } = await resolveLines(input.lines, currency);
    const coupon = await prisma.coupon.findUnique({ where: { code: input.code.trim().toUpperCase() } });
    if (!coupon) return res.json({ valid: false, error: 'This coupon code does not exist.', discount: 0 });

    const customerKey = req.customer ? `acct:${req.customer.sub}` : `guest:${String(req.body?.email ?? '').trim().toLowerCase()}`;
    const priorUses = await prisma.couponRedemption.count({ where: { couponId: coupon.id, customerKey } });
    const cartLines: CartLineForCoupon[] = resolved.map((l) => ({ productId: l.productId, categoryId: l.categoryId, lineTotal: l.lineTotalConverted }));
    const evaluation = evaluateCoupon(coupon, cartLines, currency, new Date(), priorUses);
    res.json(evaluation.ok ? { valid: true, error: null, discount: evaluation.discount } : { valid: false, error: evaluation.error, discount: 0 });
  }),
);

checkoutRouter.post(
  '/orders',
  route(async (req, res) => {
    const input: PlaceOrderInput = placeOrderSchema.parse(req.body);
    assertPaymentMethodAvailable(input.paymentMethod);

    const customerKey = req.customer ? `acct:${req.customer.sub}` : `guest:${input.email.trim().toLowerCase()}`;

    // Idempotent retry: the same key returns the original order untouched.
    const already = await prisma.order.findUnique({ where: { idempotencyKey: input.idempotencyKey }, include: ORDER_INCLUDE });
    if (already) return res.status(200).json(toStorefrontOrder(already));

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
    const customerId = req.customer?.sub ?? null;

    // Guest orders get a one-time, high-entropy access token (returned once, below) that stands in for
    // the session an account order already has — see the comment on GET /:id for how it's used. Only
    // the hash is ever stored; the raw value exists only in this request and the one response below.
    const guestToken = customerId ? null : randomBytes(32).toString('hex');

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
          guestTokenExpiresAt: guestToken ? new Date(Date.now() + GUEST_TOKEN_TTL_MS) : null,
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

    res.status(201).json({ ...toStorefrontOrder(order), ...(guestToken ? { accessToken: guestToken } : {}) });
  }),
);

// --- order tracking / retrieval (public routes, each with its own, deliberately different strength) -
//
//   GET /api/orders/track   - by the human-readable, SEQUENTIAL order number (YS-240501, YS-240502...),
//                             which IS guessable, so it additionally requires the matching email, and
//                             returns a trimmed view (no full address/phone/email) since number+email
//                             is a much weaker proof of ownership than what the full view below needs.
//   GET /api/orders/:id     - the full order, by its unguessable cuid. An account order additionally
//                             requires the signed-in customer to be its owner (the id alone is not
//                             enough — see auth.ts/customerAuth.ts review history for why that used to
//                             be the only check and was not sufficient). A guest order additionally
//                             requires the one-time access token minted at checkout (see POST /orders
//                             above), sent as the X-Order-Token header — never a query string, so it
//                             can't end up in a server log, analytics event, or a Referer header sent to
//                             a third party. Both branches respond with Cache-Control: no-store.

orderTrackRouter.get(
  '/track',
  orderLookupLimiter,
  route(async (req, res) => {
    const input = orderTrackSchema.parse({ number: req.query.number, email: req.query.email });
    const order = await prisma.order.findFirst({
      where: { number: { equals: input.number.trim() }, customerEmail: input.email.trim().toLowerCase() },
      include: ORDER_INCLUDE,
    });
    // Both the order number AND the email must match — never leak an order by number alone.
    if (!order) throw notFound('No order found for that order number and email.');
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(toStorefrontOrderTrack(order));
  }),
);

// Registered BEFORE "/:id" — otherwise Express would match "/track" itself as an :id value.
orderTrackRouter.get(
  '/:id',
  orderLookupLimiter,
  route(async (req, res) => {
    const order = await prisma.order.findUnique({ where: { id: req.params.id }, include: ORDER_INCLUDE });
    // A single, identical 404 for "no such order", "exists but belongs to another account", and
    // "exists but the guest token is missing/wrong/expired" — an order id must never, by itself, even
    // confirm that an order exists.
    if (!order) throw notFound('Order not found.');

    if (order.customerId) {
      if (!req.customer || req.customer.sub !== order.customerId) throw notFound('Order not found.');
    } else {
      const suppliedToken = req.get('x-order-token');
      const stillValid = order.guestTokenExpiresAt ? order.guestTokenExpiresAt.getTime() > Date.now() : false;
      const tokenMatches = !!suppliedToken && !!order.guestTokenHash && stillValid && safeEqual(hashGuestToken(suppliedToken), order.guestTokenHash);
      if (!tokenMatches) throw notFound('Order not found.');
    }

    res.setHeader('Cache-Control', 'private, no-store');
    res.json(toStorefrontOrder(order, await loadLineExtras([order.id])));
  }),
);
