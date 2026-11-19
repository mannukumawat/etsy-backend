import { Router } from 'express';
import { route } from '../../shared/http/async-route.js';
import { attachCustomer } from '../../shared/middleware/customer-auth.middleware.js';
import { couponValidationLimiter } from '../../shared/middleware/rate-limit.middleware.js';
import { toStorefrontOrder } from '../orders/order.mapper.js';
import { env } from '../../shared/config/env.js';
import { badRequest } from '../../shared/errors/http-error.js';
import { checkoutTotalsSchema, placeOrderSchema, validateCouponSchema, type PlaceOrderInput } from './checkout.schema.js';
import { computePreview, previewCheckoutTotals, validateCheckoutCoupon } from './checkout.service.js';
import { placeOrder } from './order-placement.service.js';
import { createRazorpayOrder } from './payment.service.js';
import { z } from 'zod';

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

/** Returns the publishable Razorpay key so the frontend can initialise the checkout modal. */
checkoutRouter.get('/razorpay/key', route(async (_req, res) => {
  if (env.PAYMENT_GATEWAY !== 'razorpay' || !env.RAZORPAY_KEY_ID) {
    return res.status(404).json({ error: { message: 'Razorpay not configured.' } });
  }
  res.json({ keyId: env.RAZORPAY_KEY_ID });
}));

/** Creates a Razorpay order whose amount is computed server-side from the checkout quote,
 *  so the client can never inflate or deflate the charge. Returns the provider order id + the
 *  exact amount the customer will be charged, for display in the confirmation modal. */
checkoutRouter.post('/razorpay/create-order', route(async (req, res) => {
  if (env.PAYMENT_GATEWAY !== 'razorpay') throw badRequest('Razorpay not configured.');
  // Accept the same fields as /totals so we can recompute the authoritative total here.
  const input = checkoutTotalsSchema.extend({ receipt: z.string().min(1).max(40) }).parse(req.body);
  const { totals } = await computePreview(
    { lines: input.lines, currency: input.currency, country: input.country, region: input.region, shippingMethodId: input.shippingMethodId, couponCode: input.couponCode },
    req.customer?.sub ? `acct:${req.customer.sub}` : `guest:${String(req.body?.email ?? '').trim().toLowerCase()}`,
  );
  const order = await createRazorpayOrder(totals.total, input.currency, input.receipt);
  res.json({ id: order.id, amount: order.amount, currency: order.currency });
}));

checkoutRouter.post(
  '/orders',
  route(async (req, res) => {
    const input: PlaceOrderInput = placeOrderSchema.parse(req.body);
    const result = await placeOrder(input, req.customer?.sub ?? null);
    if (result.replayed) return res.status(200).json(toStorefrontOrder(result.order));
    res.status(201).json({ ...toStorefrontOrder(result.order), ...(result.guestToken ? { accessToken: result.guestToken } : {}) });
  }),
);
