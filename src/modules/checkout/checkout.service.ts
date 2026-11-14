import { mediaUrl } from '../../shared/config/env.js';
import { prisma } from '../../shared/database/prisma.js';
import { badRequest } from '../../shared/errors/http-error.js';
import { convertFromBase } from '../../shared/utils/currency.js';
import { evaluateCoupon, type CartLineForCoupon } from '../coupons/coupon-rules.service.js';
import type { CheckoutTotalsInput, ValidateCouponInput } from './checkout.schema.js';
import type { Buyer, ResolvedLine, StockIssue } from './checkout.types.js';
import { calculateTotals, getShippingQuote, getShippingQuotes, getTaxRate } from './pricing.service.js';

// Server-calculated checkout: the client never computes a total that is trusted. Both /totals (a
// preview, no side effects) and /orders (places a real order) run the exact same pricing pipeline in
// pricing.service.ts, so a preview and the order it leads to can never disagree.

export const customerKeyFor = (buyer: Buyer) => (buyer.customerId ? `acct:${buyer.customerId}` : `guest:${buyer.email.trim().toLowerCase()}`);

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

/** The single pricing pipeline behind both the totals preview and order placement. */
export async function computePreview(input: CheckoutTotalsInput, customerKey: string) {
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

/** POST /totals: a side-effect-free preview of exactly what placing this cart would charge. */
export async function previewCheckoutTotals(input: CheckoutTotalsInput, buyer: Buyer) {
  const { resolved, stockIssues, quote, quotes, taxRate, totals, couponError } = await computePreview(input, customerKeyFor(buyer));

  return {
    lines: resolved.map((l) => ({ productId: l.productId, variantId: l.variantId, quantity: l.quantity, unitPrice: l.unitPriceConverted, lineTotal: l.lineTotalConverted })),
    shippingQuotes: quotes,
    shippingSupported: !!quote,
    taxRate,
    couponValid: !!input.couponCode && !couponError,
    couponError,
    stockIssues,
    totals,
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
