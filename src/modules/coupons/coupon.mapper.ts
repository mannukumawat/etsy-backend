import { parseStringArray } from '../../shared/utils/json.js';
import { couponState } from './coupon-rules.service.js';

export function toAdminCoupon(c: {
  id: string; code: string; description: string; type: string; value: number; maxDiscount: number | null; minOrder: number | null;
  startsAt: Date | null; endsAt: Date | null; isActive: boolean; usageLimit: number | null; perCustomerLimit: number | null;
  timesUsed: number; scope: string; productIds: string; categoryIds: string; createdAt: Date; updatedAt: Date;
}) {
  return {
    id: c.id,
    code: c.code,
    description: c.description,
    type: c.type as 'percentage' | 'fixed',
    value: c.value,
    maxDiscount: c.maxDiscount,
    minOrder: c.minOrder,
    startsAt: c.startsAt ? c.startsAt.toISOString() : null,
    endsAt: c.endsAt ? c.endsAt.toISOString() : null,
    isActive: c.isActive,
    usageLimit: c.usageLimit,
    perCustomerLimit: c.perCustomerLimit,
    timesUsed: c.timesUsed,
    scope: c.scope as 'all' | 'products' | 'categories',
    productIds: parseStringArray(c.productIds),
    categoryIds: parseStringArray(c.categoryIds),
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

/** Admin shape plus the coupon's live lifecycle state (active / scheduled / expired / inactive / exhausted). */
export function toAdminCouponWithState(c: Parameters<typeof toAdminCoupon>[0], now: Date) {
  return { ...toAdminCoupon(c), state: couponState(c, now) };
}
