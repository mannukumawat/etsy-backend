import { Router } from 'express';
import { route } from '../../shared/http/async-route.js';
import { attachCustomer } from '../../shared/middleware/customer-auth.middleware.js';
import { checkoutLimiter, couponValidationLimiter } from '../../shared/middleware/rate-limit.middleware.js';
import { toStorefrontOrder } from '../orders/order.mapper.js';
import { prisma } from '../../shared/database/prisma.js';
import { env } from '../../shared/config/env.js';
import { badRequest } from '../../shared/errors/http-error.js';
import { convertFromBase } from '../../shared/utils/currency.js';
import { checkoutTotalsSchema, createRazorpayOrderSchema, placeOrderSchema, validateCouponSchema, type PlaceOrderInput } from './checkout.schema.js';
import { computePreview, previewCheckoutTotals, validateCheckoutCoupon } from './checkout.service.js';
import { placeOrder } from './order-placement.service.js';
import { assertPaymentMethodForCountry, createRazorpayOrder } from './payment.service.js';
import { splitWalletPayment } from './wallet-split.js';
import { getBalance } from '../wallet/wallet.service.js';
import { createHolds } from './stock-hold.service.js';

// Server-calculated checkout: the client never computes a total that is trusted. Both /totals (a
// preview, no side effects) and /orders (places a real order) run the exact same pricing pipeline in
// pricing.service.ts, so a preview and the order it leads to can never disagree.
//
// H12: the money endpoints (/totals, /orders, /razorpay/create-order) are rate-limited
// by `checkoutLimiter` from the shared rate-limit middleware.

export const checkoutRouter = Router();
checkoutRouter.use(attachCustomer);

checkoutRouter.post(
  '/totals',
  checkoutLimiter,
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

/** Creates a Razorpay order whose amount is computed server-side from the checkout quote,
 *  so the client can never inflate or deflate the charge. For a split wallet payment the
 *  Razorpay order is created for the REMAINDER only (total - walletPartialMinor); the wallet
 *  leg is validated against the customer's real DB balance here and debited at order time.
 *  Returns the provider order id + the exact amount the customer will be charged, for
 *  display in the confirmation modal.
 *  L4: the Razorpay order is persisted (razorpay_orders) with the receipt bound to the
 *  idempotency key, and stock is held for 15 minutes (H5) so the last unit cannot be
 *  sold twice while the customer is in the Razorpay modal. */
checkoutRouter.post('/razorpay/create-order', checkoutLimiter, route(async (req, res) => {
  if (env.PAYMENT_GATEWAY !== 'razorpay') throw badRequest('Razorpay not configured.');
  const input = createRazorpayOrderSchema.parse(req.body);
  // The receipt MUST be derived from the idempotency key — a client-supplied receipt
  // that differs is rejected, so a later placeOrder can only ever match the order
  // created for the same checkout attempt.
  const receipt = input.idempotencyKey.slice(0, 40);
  if (input.receipt !== undefined && input.receipt !== receipt) {
    throw badRequest('Receipt must match the idempotency key.', [{ path: 'receipt', message: 'Receipt must match the idempotency key.' }]);
  }
  // Country-specific payments: UPI is India-only (also enforced in placeOrder).
  if (input.paymentMethod) assertPaymentMethodForCountry(input.paymentMethod, input.country);
  const { totals, context } = await computePreview(
    { lines: input.lines, currency: input.currency, country: input.country, region: input.region, shippingMethodId: input.shippingMethodId, couponCode: input.couponCode },
    req.customer?.sub ? `acct:${req.customer.sub}` : `guest:${String(req.body?.email ?? '').trim().toLowerCase()}`,
  );
  const walletPartialMinor = input.walletPartialMinor ?? 0;
  // splitWalletPayment rejects a partial above the total; partial === total is a full-wallet
  // order and must never reach Razorpay at all.
  const split = splitWalletPayment(totals.total, walletPartialMinor);
  if (walletPartialMinor > 0) {
    if (!req.customer?.sub) throw badRequest('You must be signed in to pay with your wallet.', [{ path: 'walletPartialMinor', message: 'Sign in required.' }]);
    if (split.isFullWallet) throw badRequest('Wallet payment already covers the order total. Pay with your wallet instead of Razorpay.', [{ path: 'walletPartialMinor', message: 'Covers the full total.' }]);
    const balanceUsdCents = await getBalance(req.customer.sub);
    // Convert wallet USD balance to display currency for comparison
    const balanceDisplayMinor = convertFromBase(balanceUsdCents, context.currency);
    if (walletPartialMinor > balanceDisplayMinor) {
      throw badRequest(`Insufficient wallet balance.`, [{ path: 'walletPartialMinor', message: 'Exceeds wallet balance.' }]);
    }
  }
  const order = await createRazorpayOrder(split.razorpayMinor, input.currency, receipt);
  // Persist the Razorpay order (L4): binds the gateway order to the server-computed
  // amount/currency and to the requester. placeOrder marks it 'paid' on success.
  const customerKey = req.customer?.sub ? `acct:${req.customer.sub}` : `guest:${String(req.body?.email ?? '').trim().toLowerCase()}`;
  await prisma.razorpayOrder.create({
    data: {
      razorpayOrderId: order.id,
      amount: Number(order.amount),
      currency: order.currency,
      receipt,
      customerKey,
      status: 'created',
    },
  });
  // Hold the stock for this checkout attempt (H5); expired holds are swept first.
  await createHolds({
    razorpayOrderId: order.id,
    customerKey,
    lines: input.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
  });
  res.json({ id: order.id, amount: order.amount, currency: order.currency });
}));

checkoutRouter.post(
  '/orders',
  checkoutLimiter,
  route(async (req, res) => {
    const input: PlaceOrderInput = placeOrderSchema.parse(req.body);
    const result = await placeOrder(input, req.customer?.sub ?? null);
    if (result.replayed) return res.status(200).json(toStorefrontOrder(result.order));
    res.status(201).json({ ...toStorefrontOrder(result.order), ...(result.guestToken ? { accessToken: result.guestToken } : {}) });
  }),
);
