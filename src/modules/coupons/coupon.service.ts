import { prisma } from '../../shared/database/prisma.js';
import { badRequest, conflict, notFound } from '../../shared/errors/http-error.js';
import { stringifyJson } from '../../shared/utils/json.js';
import type { CouponInput } from './coupon.schema.js';

/** M-O14: server-side search/state filter + pagination — the admin used to fetch the
 *  whole list and filter client-side. `state` mirrors couponState() exactly:
 *  inactive → isActive false; exhausted → usageLimit reached; scheduled → starts in
 *  the future; expired → ended in the past; active → everything else live. */
export interface CouponListQuery {
  q: string;
  state: string;
  page: number;
  pageSize: number;
}

export async function listCoupons(query: CouponListQuery) {
  const now = new Date();
  // The lifecycle state is a computed value (couponState(): active/scheduled/
  // expired/inactive/exhausted from isActive + dates + usage) that Prisma cannot
  // express as a single WHERE — null start/end dates must count as "no bound", and
  // "exhausted" is a column-to-column comparison. So the DB filters what it can
  // (search + isActive) and the state is applied in JS on that small set.
  const where = {
    ...(query.q ? { OR: [{ code: { contains: query.q } }, { description: { contains: query.q } }] } : {}),
    ...(query.state === 'inactive' ? { isActive: false } : query.state ? { isActive: true } : {}),
  };
  const all = await prisma.coupon.findMany({ where, orderBy: { code: 'asc' } });
  const stateOf = (c: { isActive: boolean; usageLimit: number | null; timesUsed: number; startsAt: Date | null; endsAt: Date | null }) =>
    !c.isActive ? 'inactive'
    : c.usageLimit != null && c.timesUsed >= c.usageLimit ? 'exhausted'
    : c.startsAt && c.startsAt > now ? 'scheduled'
    : c.endsAt && c.endsAt < now ? 'expired'
    : 'active';
  const rows = query.state ? all.filter((c) => stateOf(c) === query.state) : all;
  const total = rows.length;
  const pageSize = Math.min(100, Math.max(1, query.pageSize));
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, query.page), pageCount);
  // M-O14: per-state counts for the filter labels, over the same search but ignoring
  // the state filter (coupon table is small; one extra lightweight select).
  const counted = query.state
    ? await prisma.coupon.findMany({
        where: query.q ? { OR: [{ code: { contains: query.q } }, { description: { contains: query.q } }] } : {},
        select: { isActive: true, usageLimit: true, timesUsed: true, startsAt: true, endsAt: true },
      })
    : all;
  const stateCounts: Record<string, number> = {};
  for (const c of counted) stateCounts[stateOf(c)] = (stateCounts[stateOf(c)] ?? 0) + 1;
  return { items: rows.slice((page - 1) * pageSize, page * pageSize), total, page, pageSize, pageCount, stateCounts };
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
