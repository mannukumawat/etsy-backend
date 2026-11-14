import { convertFromBase, type CurrencyConfigLike } from '../../shared/utils/currency.js';
import { parseStringArray } from '../../shared/utils/json.js';

export interface CouponLike {
  type: string; // 'percentage' | 'fixed'
  value: number;
  maxDiscount: number | null;
  minOrder: number | null;
  startsAt: Date | null;
  endsAt: Date | null;
  isActive: boolean;
  usageLimit: number | null;
  perCustomerLimit: number | null;
  timesUsed: number;
  scope: string; // 'all' | 'products' | 'categories'
  productIds: string;
  categoryIds: string;
}

export type CouponState = 'active' | 'scheduled' | 'expired' | 'inactive' | 'exhausted';

export function couponState(c: CouponLike, now: Date): CouponState {
  if (!c.isActive) return 'inactive';
  if (c.usageLimit != null && c.timesUsed >= c.usageLimit) return 'exhausted';
  if (c.startsAt && c.startsAt > now) return 'scheduled';
  if (c.endsAt && c.endsAt < now) return 'expired';
  return 'active';
}

export interface CartLineForCoupon {
  productId: string;
  categoryId: string;
  /** Already converted to the order's currency. */
  lineTotal: number;
  /** Base (USD) unit price, used to convert the coupon's own USD-base amounts consistently. */
}

export interface CouponEvaluation {
  ok: boolean;
  error?: string;
  /** Converted to the order's currency. */
  discount: number;
}

/** Re-implements admin/src/utils/couponRules.ts `evaluateCoupon` exactly, operating on already
 *  currency-converted line totals. Coupon `value`/`maxDiscount`/`minOrder` are USD-base and are
 *  converted here via the same rate snapshot as everything else. */
export function evaluateCoupon(
  coupon: CouponLike,
  lines: CartLineForCoupon[],
  currency: CurrencyConfigLike,
  now: Date,
  priorUsesByThisCustomer: number,
): CouponEvaluation {
  const state = couponState(coupon, now);
  if (state !== 'active') return { ok: false, error: `This coupon is ${state}.`, discount: 0 };
  if (coupon.perCustomerLimit != null && priorUsesByThisCustomer >= coupon.perCustomerLimit) {
    return { ok: false, error: 'You have already used this coupon the maximum number of times.', discount: 0 };
  }

  const subtotal = lines.reduce((sum, l) => sum + l.lineTotal, 0);
  const minOrder = coupon.minOrder != null ? convertFromBase(coupon.minOrder, currency) : null;
  if (minOrder != null && subtotal < minOrder) {
    return { ok: false, error: 'Your order does not meet this coupon’s minimum amount.', discount: 0 };
  }

  const productIds = new Set(parseStringArray(coupon.productIds));
  const categoryIds = new Set(parseStringArray(coupon.categoryIds));
  const eligibleLines =
    coupon.scope === 'products' ? lines.filter((l) => productIds.has(l.productId))
    : coupon.scope === 'categories' ? lines.filter((l) => categoryIds.has(l.categoryId))
    : lines;
  const eligibleSubtotal = eligibleLines.reduce((sum, l) => sum + l.lineTotal, 0);
  if (eligibleSubtotal <= 0) return { ok: false, error: 'No items in your cart are eligible for this coupon.', discount: 0 };

  const maxDiscount = coupon.maxDiscount != null ? convertFromBase(coupon.maxDiscount, currency) : null;
  let discount: number;
  if (coupon.type === 'percentage') {
    discount = Math.round(eligibleSubtotal * (coupon.value / 100));
    if (maxDiscount != null) discount = Math.min(discount, maxDiscount);
  } else {
    discount = convertFromBase(coupon.value, currency);
  }
  discount = Math.min(discount, eligibleSubtotal);
  return { ok: true, discount };
}
