import { mediaUrl } from '../../shared/config/env.js';
import { prisma } from '../../shared/database/prisma.js';
import { badRequest } from '../../shared/errors/http-error.js';
import { convertFromBase } from '../../shared/utils/currency.js';
import { evaluateCoupon, type CartLineForCoupon } from '../coupons/coupon-rules.service.js';
import type { CheckoutTotalsInput, ValidateCouponInput } from './checkout.schema.js';
import type { Buyer, ResolvedLine, StockIssue, WalletPreviewInfo } from './checkout.types.js';
import { calculateTotals, getShippingQuote, getShippingQuotes, getTaxRate } from './pricing.service.js';
import { getBalance } from '../wallet/wallet.service.js';
import { availableAfterHolds, reservedQuantities } from './stock-hold.service.js';
import { isRateStale } from '../settings/exchange-rate.service.js';
import { logger } from '../../shared/observability/logger.js';

// Server-calculated checkout: the client never computes a total that is trusted. Both /totals (a
// preview, no side effects) and /orders (places a real order) run the exact same pricing pipeline in
// pricing.service.ts, so a preview and the order it leads to can never disagree.

export const customerKeyFor = (buyer: Buyer) => (buyer.customerId ? `acct:${buyer.customerId}` : `guest:${buyer.email.trim().toLowerCase()}`);

async function loadPricingContext(currencyCode: string) {
  const [allCurrencies, shipping, tax, store, currencySettings] = await Promise.all([
    prisma.currencyConfig.findMany({ where: { settingsId: 'singleton' } }),
    prisma.shippingSettings.findUniqueOrThrow({ where: { id: 'singleton' }, include: { zones: true } }),
    prisma.taxSettings.findUniqueOrThrow({ where: { id: 'singleton' }, include: { rules: true } }),
    prisma.storeSettings.findUnique({ where: { id: 'singleton' }, select: { maxQtyPerLine: true, handlingMinDays: true, handlingMaxDays: true } }),
    prisma.currencySettings.findUnique({ where: { id: 'singleton' }, select: { ratesUpdatedAt: true } }),
  ]);
  const currency = allCurrencies.find((c) => c.code === currencyCode && c.enabled);
  if (!currency) throw badRequest('That currency is not available.', [{ path: 'currency', message: 'Not available.' }]);
  // M-S3: never price with a missing/zero rate — a stale or broken rate config must
  // fail the checkout loudly instead of charging NaN or 0.
  if (!Number.isFinite(currency.rate) || currency.rate <= 0) {
    throw badRequest('That currency is not available right now.', [{ path: 'currency', message: 'Exchange rate unavailable.' }]);
  }
  // M12: stale-rate guard — a converted (non-USD) checkout must not price off rates
  // older than 24h (MAX_RATE_AGE_MS). USD is the base currency (rate is 1 by
  // definition) so it is never blocked. When rates were never synced at all
  // (ratesUpdatedAt null — e.g. a fresh seed), checkout still proceeds on the seeded
  // rates but logs loudly so the owner notices; refusing outright would brick every
  // non-USD checkout until the first sync runs.
  if (currencyCode !== 'USD') {
    if (!currencySettings?.ratesUpdatedAt) {
      logger.warn('exchange rates never synced, pricing checkout off seeded rates', { currency: currencyCode });
    } else if (isRateStale(currencySettings.ratesUpdatedAt)) {
      throw badRequest('Exchange rates are stale (last sync over 24 hours ago). Please try again later.', [{ path: 'currency', message: 'Exchange rates are stale.' }]);
    }
  }
  return {
    currency, allCurrencies, zones: shipping.zones, taxRules: tax.rules, defaultTaxRate: tax.defaultRate, pricesIncludeTax: tax.pricesIncludeTax,
    // M-S2: free-shipping threshold in USD minor units (null = no threshold).
    freeShippingThreshold: shipping.freeShippingThreshold ?? null,
    // M-S1: the live per-line quantity cap the owner set in Store settings (default 10).
    maxQtyPerLine: store?.maxQtyPerLine ?? 10,
    handlingDays: { min: store?.handlingMinDays ?? 1, max: store?.handlingMaxDays ?? 2 },
  };
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

  // H5: availability subtracts unexpired stock holds (other shoppers mid-checkout),
  // in one indexed query — the variant's raw stock alone would oversell the last unit.
  const reserved = await reservedQuantities(variantIds);

  for (const line of lines) {
    const variant = variants.find((v) => v.id === line.variantId && v.productId === line.productId);
    if (!variant || variant.product.status !== 'active' || !variant.product.category.isActive) {
      throw badRequest('One of the items in your cart is no longer available.', [{ path: 'lines', message: 'Unavailable.' }]);
    }
    const available = availableAfterHolds(variant.stock, reserved.get(line.variantId) ?? 0);
    if (available < line.quantity) {
      stockIssues.push({ productId: line.productId, variantId: line.variantId, requested: line.quantity, available });
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
      availableStock: available,
    });
  }
  return { resolved, stockIssues };
}

/** The single pricing pipeline behind both the totals preview and order placement. */
export async function computePreview(input: CheckoutTotalsInput, customerKey: string) {
  const context = await loadPricingContext(input.currency);
  // M-S1: the owner's per-line cap is enforced here, not just in the storefront UI —
  // a tampered client cannot order more than maxQtyPerLine of one variant.
  const overLimit = input.lines.find((l) => l.quantity > context.maxQtyPerLine);
  if (overLimit) {
    throw badRequest(`You can order at most ${context.maxQtyPerLine} of one item per line.`, [{ path: 'lines', message: `Maximum ${context.maxQtyPerLine} per line.` }]);
  }
  const { resolved, stockIssues } = await resolveLines(input.lines, context.currency);

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

  // M-S2: free shipping applies on the goods subtotal after discounts, before
  // shipping/tax — the same value the shopper sees as the order subtotal.
  const goodsSubtotal = resolved.reduce((sum, l) => sum + l.lineTotalConverted, 0) - discount;
  const freeShipping =
    context.freeShippingThreshold !== null
      ? { thresholdMinor: convertFromBase(context.freeShippingThreshold, context.currency), subtotalMinor: goodsSubtotal }
      : undefined;
  const quote = getShippingQuote(context.zones, input.country, input.shippingMethodId, context.currency, freeShipping);
  const quotes = getShippingQuotes(context.zones, input.country, context.currency, freeShipping);

  const taxRate = getTaxRate(context.taxRules, context.defaultTaxRate, input.country, input.region ?? null);
  const totals = calculateTotals({
    lineTotals: resolved.map((l) => l.lineTotalConverted),
    discount,
    shipping: quote?.amount ?? 0,
    taxRate,
    taxInclusive: context.pricesIncludeTax,
  });

  return { context, resolved, stockIssues, quote, quotes, taxRate, totals, couponError, coupon };
}

/** POST /totals: a side-effect-free preview of exactly what placing this cart would charge. */
export async function previewCheckoutTotals(input: CheckoutTotalsInput, buyer: Buyer) {
  const { resolved, stockIssues, quote, quotes, taxRate, totals, couponError } = await computePreview(input, customerKeyFor(buyer));

  // Include wallet balance for signed-in customers so the checkout UI can show the wallet option.
  let wallet: WalletPreviewInfo | null = null;
  if (buyer.customerId) {
    const balanceUsdCents = await getBalance(buyer.customerId);
    if (balanceUsdCents > 0) {
      // Convert wallet balance from USD cents to display currency minor units
      const balanceMinor = convertFromBase(balanceUsdCents, context.currency);
      wallet = {
        balanceMinor,
        maxApplicableMinor: Math.min(balanceMinor, totals.total),
      };
    }
  }

  return {
    lines: resolved.map((l) => ({ productId: l.productId, variantId: l.variantId, quantity: l.quantity, unitPrice: l.unitPriceConverted, lineTotal: l.lineTotalConverted })),
    shippingQuotes: quotes,
    shippingSupported: !!quote,
    taxRate,
    couponValid: !!input.couponCode && !couponError,
    couponError,
    stockIssues,
    totals,
    wallet,
  };
}

/** Lightweight coupon check for the bare cart page, which has no destination yet — validates the code,
 *  eligibility and minimum order against the cart contents only (no shipping/tax), returning the
 *  discount in the given currency. The authoritative check still happens again at /totals and /orders. */
export async function validateCheckoutCoupon(input: ValidateCouponInput, buyer: Buyer) {
  const currency = await prisma.currencyConfig.findFirst({ where: { settingsId: 'singleton', code: input.currency, enabled: true } });
  if (!currency) throw badRequest('That currency is not available.', [{ path: 'currency', message: 'Not available.' }]);
  const { resolved } = await resolveLines(input.lines, currency);
  const coupon = await prisma.coupon.findUnique({ where: { code: input.code.trim().toUpperCase() } });
  if (!coupon) return { valid: false, error: 'This coupon code does not exist.', discount: 0 };

  const priorUses = await prisma.couponRedemption.count({ where: { couponId: coupon.id, customerKey: customerKeyFor(buyer) } });
  const cartLines: CartLineForCoupon[] = resolved.map((l) => ({ productId: l.productId, categoryId: l.categoryId, lineTotal: l.lineTotalConverted }));
  const evaluation = evaluateCoupon(coupon, cartLines, currency, new Date(), priorUses);
  return evaluation.ok ? { valid: true, error: null, discount: evaluation.discount } : { valid: false, error: evaluation.error, discount: 0 };
}
