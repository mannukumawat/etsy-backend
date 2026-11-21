import { Router } from 'express';
import { route } from '../../shared/http/async-route.js';
import { requireOwner } from '../../shared/middleware/auth.middleware.js';
import { toAdminCouponWithState } from './coupon.mapper.js';
import { couponInputSchema } from './coupon.schema.js';
import { countCouponUses, createCoupon, deleteCoupon, getCouponOr404, listCoupons, updateCoupon } from './coupon.service.js';

export const couponsRouter = Router();
couponsRouter.use(requireOwner);

couponsRouter.get(
  '/',
  route(async (req, res) => {
    // M-O14: server pagination + search/state filter (was: whole list, client-filtered).
    const q = String(req.query.q ?? '').trim();
    const state = String(req.query.state ?? '').trim();
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
    const result = await listCoupons({ q, state, page, pageSize });
    const now = new Date();
    res.json({ ...result, items: result.items.map((r) => toAdminCouponWithState(r, now)) });
  }),
);

couponsRouter.post(
  '/',
  route(async (req, res) => {
    const input = couponInputSchema.parse(req.body);
    const row = await createCoupon(input);
    res.status(201).json(toAdminCouponWithState(row, new Date()));
  }),
);

couponsRouter.put(
  '/:id',
  route(async (req, res) => {
    // The coupon must exist before the body is looked at: an unknown id answers 404 even for an invalid body.
    const existing = await getCouponOr404(req.params.id);
    const input = couponInputSchema.parse(req.body);
    const row = await updateCoupon(existing, input);
    res.json(toAdminCouponWithState(row, new Date()));
  }),
);

couponsRouter.delete(
  '/:id',
  route(async (req, res) => {
    await deleteCoupon(req.params.id);
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
    res.json({ uses: await countCouponUses(code, email) });
  }),
);
