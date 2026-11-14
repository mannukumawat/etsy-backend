import { prisma } from '../../shared/database/prisma.js';
import { badRequest, conflict, notFound } from '../../shared/errors/http-error.js';
import { stringifyJson } from '../../shared/utils/json.js';
import type { CouponInput } from './coupon.schema.js';

export function listCoupons() {
  return prisma.coupon.findMany({ orderBy: { code: 'asc' } });
}

export async function getCouponOr404(id: string) {
  const existing = await prisma.coupon.findUnique({ where: { id } });
  if (!existing) throw notFound('Coupon not found.');
  return existing;
}

async function assertCodeFree(code: string, selfId: string | null) {
  const clash = await prisma.coupon.findUnique({ where: { code } });
  if (clash && clash.id !== selfId) throw conflict('Another coupon already uses this code.', [{ path: 'code', message: 'Already in use.' }]);
}

async function assertReferencesExist(input: { scope: string; productIds: string[]; categoryIds: string[] }) {
  if (input.scope === 'products' && input.productIds.length) {
    const found = await prisma.product.count({ where: { id: { in: input.productIds } } });
    if (found !== input.productIds.length) throw badRequest('A selected product no longer exists.', [{ path: 'productIds', message: 'Not found.' }]);
  }
  if (input.scope === 'categories' && input.categoryIds.length) {
    const found = await prisma.category.count({ where: { id: { in: input.categoryIds } } });
    if (found !== input.categoryIds.length) throw badRequest('A selected category no longer exists.', [{ path: 'categoryIds', message: 'Not found.' }]);
  }
}

const toCouponData = (input: CouponInput) => ({
  code: input.code, description: input.description, type: input.type, value: input.value,
  maxDiscount: input.maxDiscount, minOrder: input.minOrder, startsAt: input.startsAt, endsAt: input.endsAt,
  isActive: input.isActive, usageLimit: input.usageLimit, perCustomerLimit: input.perCustomerLimit,
  scope: input.scope, productIds: stringifyJson(input.productIds), categoryIds: stringifyJson(input.categoryIds),
});

export async function createCoupon(input: CouponInput) {
  await assertCodeFree(input.code, null);
  await assertReferencesExist(input);
  return prisma.coupon.create({ data: toCouponData(input) });
}

/** `existing` is the coupon the caller already loaded (and 404-checked) via getCouponOr404. */
export async function updateCoupon(existing: { id: string }, input: CouponInput) {
  await assertCodeFree(input.code, existing.id);
  await assertReferencesExist(input);
  return prisma.coupon.update({ where: { id: existing.id }, data: toCouponData(input) });
}

export async function deleteCoupon(id: string) {
  const existing = await getCouponOr404(id);
  if (existing.timesUsed > 0) {
    throw conflict('This coupon was used on orders. Deactivate it instead of deleting, so order history stays meaningful.');
  }
  await prisma.coupon.delete({ where: { id: existing.id } });
}

/** How many times a customer (by email, guest or signed-in) redeemed a code; 0 for an unknown code. */
export async function countCouponUses(code: string, email: string): Promise<number> {
  const coupon = await prisma.coupon.findUnique({ where: { code } });
  if (!coupon) return 0;
  const uses = await prisma.couponRedemption.count({ where: { couponId: coupon.id, customerKey: `guest:${email}` } });
  const acctUses = await prisma.couponRedemption.count({
    where: { couponId: coupon.id, customerKey: { startsWith: 'acct:' }, order: { customerEmail: email } },
  });
  return uses + acctUses;
}
