import { Router } from 'express';
import { requireOwner } from '../auth.js';
import { prisma } from '../db.js';
import { badRequest, conflict, notFound, route } from '../http.js';
import { stringifyJson } from '../json.js';
import { toAdminCoupon } from '../mappers.js';
import { couponState } from '../pricing.js';
import { couponInputSchema } from '../validation.js';

export const couponsRouter = Router();
couponsRouter.use(requireOwner);

couponsRouter.get(
  '/',
  route(async (_req, res) => {
    const rows = await prisma.coupon.findMany({ orderBy: { code: 'asc' } });
    const now = new Date();
    res.json({ items: rows.map((r) => ({ ...toAdminCoupon(r), state: couponState(r, now) })) });
  }),
);

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

couponsRouter.post(
  '/',
  route(async (req, res) => {
    const input = couponInputSchema.parse(req.body);
    await assertCodeFree(input.code, null);
    await assertReferencesExist(input);
    const row = await prisma.coupon.create({
      data: {
        code: input.code, description: input.description, type: input.type, value: input.value,
        maxDiscount: input.maxDiscount, minOrder: input.minOrder, startsAt: input.startsAt, endsAt: input.endsAt,
        isActive: input.isActive, usageLimit: input.usageLimit, perCustomerLimit: input.perCustomerLimit,
        scope: input.scope, productIds: stringifyJson(input.productIds), categoryIds: stringifyJson(input.categoryIds),
      },
    });
    res.status(201).json({ ...toAdminCoupon(row), state: couponState(row, new Date()) });
  }),
);

couponsRouter.put(
  '/:id',
  route(async (req, res) => {
    const existing = await prisma.coupon.findUnique({ where: { id: req.params.id } });
    if (!existing) throw notFound('Coupon not found.');
    const input = couponInputSchema.parse(req.body);
    await assertCodeFree(input.code, existing.id);
    await assertReferencesExist(input);
    const row = await prisma.coupon.update({
      where: { id: existing.id },
      data: {
        code: input.code, description: input.description, type: input.type, value: input.value,
        maxDiscount: input.maxDiscount, minOrder: input.minOrder, startsAt: input.startsAt, endsAt: input.endsAt,
        isActive: input.isActive, usageLimit: input.usageLimit, perCustomerLimit: input.perCustomerLimit,
        scope: input.scope, productIds: stringifyJson(input.productIds), categoryIds: stringifyJson(input.categoryIds),
      },
    });
    res.json({ ...toAdminCoupon(row), state: couponState(row, new Date()) });
  }),
);

couponsRouter.delete(
  '/:id',
  route(async (req, res) => {
    const existing = await prisma.coupon.findUnique({ where: { id: req.params.id } });
    if (!existing) throw notFound('Coupon not found.');
    if (existing.timesUsed > 0) {
      throw conflict('This coupon was used on orders. Deactivate it instead of deleting, so order history stays meaningful.');
    }
    await prisma.coupon.delete({ where: { id: existing.id } });
    res.status(204).end();
  }),
);

/** How many times a customer used a code (admin's coupon-editor preview calculator). */
couponsRouter.get(
  '/uses',
  route(async (req, res) => {
    const code = String(req.query.code ?? '').trim().toUpperCase();
    const email = String(req.query.email ?? '').trim().toLowerCase();
    if (!code || !email) return res.json({ uses: 0 });
    const coupon = await prisma.coupon.findUnique({ where: { code } });
    if (!coupon) return res.json({ uses: 0 });
    const uses = await prisma.couponRedemption.count({ where: { couponId: coupon.id, customerKey: `guest:${email}` } });
    const acctUses = await prisma.couponRedemption.count({
      where: { couponId: coupon.id, customerKey: { startsWith: 'acct:' }, order: { customerEmail: email } },
    });
    res.json({ uses: uses + acctUses });
  }),
);
