import { Router } from 'express';
import { route } from '../../shared/http/async-route.js';
import { attachCustomer } from '../../shared/middleware/customer-auth.middleware.js';
import { couponValidationLimiter } from '../../shared/middleware/rate-limit.middleware.js';
import { toStorefrontOrder } from '../orders/order.mapper.js';
import { checkoutTotalsSchema, placeOrderSchema, validateCouponSchema, type PlaceOrderInput } from './checkout.schema.js';
import { previewCheckoutTotals, validateCheckoutCoupon } from './checkout.service.js';
import { placeOrder } from './order-placement.service.js';

// Server-calculated checkout: the client never computes a total that is trusted. Both /totals (a
// preview, no side effects) and /orders (places a real order) run the exact same pricing pipeline in
// pricing.service.ts, so a preview and the order it leads to can never disagree.

export const checkoutRouter = Router();
checkoutRouter.use(attachCustomer);

checkoutRouter.post(
  '/totals',
  route(async (req, res) => {
    const input = checkoutTotalsSchema.parse(req.body);
    const preview = await previewCheckoutTotals(input, { customerId: req.customer?.sub ?? null, email: String(req.body?.email ?? '') });
    res.json(preview);
  }),
);

checkoutRouter.post(
  '/validate-coupon',
  couponValidationLimiter,
  route(async (req, res) => {
    const input = validateCouponSchema.parse(req.body);
    const result = await validateCheckoutCoupon(input, { customerId: req.customer?.sub ?? null, email: String(req.body?.email ?? '') });
    res.json(result);
  }),
);

checkoutRouter.post(
  '/orders',
  route(async (req, res) => {
    const input: PlaceOrderInput = placeOrderSchema.parse(req.body);
    const result = await placeOrder(input, req.customer?.sub ?? null);
    if (result.replayed) return res.status(200).json(toStorefrontOrder(result.order));
    res.status(201).json({ ...toStorefrontOrder(result.order), ...(result.guestToken ? { accessToken: result.guestToken } : {}) });
  }),
);
