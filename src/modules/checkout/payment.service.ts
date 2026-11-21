import crypto from 'node:crypto';
import Razorpay from 'razorpay';
import { badRequest } from '../../shared/errors/http-error.js';
import { env, isPaymentGatewayConfigured, paymentGatewaySetupHelp } from '../../shared/config/env.js';

export type PaymentMethod = 'card' | 'upi' | 'wallet';

let razorpay: Razorpay | null = null;
if (env.PAYMENT_GATEWAY === 'razorpay' && env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET) {
  razorpay = new Razorpay({ key_id: env.RAZORPAY_KEY_ID, key_secret: env.RAZORPAY_KEY_SECRET });
}

/** Creates a Razorpay order for the given amount (in smallest currency unit, e.g. paise for INR). */
export async function createRazorpayOrder(amountInSmallestUnit: number, currency: string, receiptId: string) {
  if (!razorpay) throw badRequest('Payment gateway not configured.');
  const order = await razorpay.orders.create({
    amount: Math.round(amountInSmallestUnit),
    currency,
    receipt: receiptId.slice(0, 40),
  });
  return order;
}

/** True when a Razorpay client exists (gateway + keys configured). */
export function isRazorpayConfigured(): boolean {
  return razorpay !== null;
}

export interface GatewayRefund {
  id: string;
  /** Razorpay refund status: 'processed' means the money has moved. */
  status: string;
}

/**
 * Refunds a captured Razorpay payment, in the payment's own currency and for the exact
 * minor-unit amount given. The refund is always issued in the SAME currency as the
 * original charge — the caller passes the order's currency amount, never a converted
 * one. Throws when the gateway is not configured or rejects the refund; the caller
 * must only record the refund as completed after this resolves with status 'processed'.
 */
export async function refundRazorpayPayment(
  razorpayPaymentId: string,
  amountInSmallestUnit: number,
  notes?: Record<string, string>,
): Promise<GatewayRefund> {
  if (!razorpay) throw badRequest('Payment gateway not configured.');
  const refund = await razorpay.payments.refund(razorpayPaymentId, {
    amount: Math.round(amountInSmallestUnit),
    ...(notes ? { notes } : {}),
  });
  return { id: String(refund.id), status: String(refund.status) };
}

/** Verifies that the payment signature from Razorpay is genuine. Throws 400 on tampered data. */
export function verifyRazorpaySignature(razorpayOrderId: string, razorpayPaymentId: string, signature: string) {
  if (!env.RAZORPAY_KEY_SECRET) throw badRequest('Payment gateway not configured.');
  const expected = crypto
    .createHmac('sha256', env.RAZORPAY_KEY_SECRET)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest('hex');
  // M1: constant-time comparison — a plain `!==` leaks the correct prefix length
  // through timing. Same pattern as verifyRazorpayWebhookSignature (webhook.ts).
  const given = Buffer.from(signature, 'utf8');
  const want = Buffer.from(expected, 'utf8');
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    throw badRequest('Payment verification failed. Do not retry — contact support.', [{ path: 'razorpaySignature', message: 'Invalid signature.' }]);
  }
}

export function assertPaymentMethodAvailable(method: PaymentMethod) {
  if (!isPaymentGatewayConfigured) {
    throw badRequest(
      `${method.toUpperCase()} payment is not available yet. ${paymentGatewaySetupHelp}`,
      [{ path: 'paymentMethod', message: 'Payment gateway not configured.' }],
    );
  }
}

/**
 * Country-specific payment methods: UPI is an India-only payment method. International
 * shoppers must never be offered (or able to submit) UPI — the storefront filters it
 * out of the UI, and this is the server-side enforcement for both checkout entry
 * points (create-order and placeOrder).
 */
export function assertPaymentMethodForCountry(method: PaymentMethod, countryCode: string) {
  if (method === 'upi' && countryCode.trim().toUpperCase() !== 'IN') {
    throw badRequest('UPI is only available for payments from India.', [{ path: 'paymentMethod', message: 'UPI is only available for payments from India.' }]);
  }
}

/** Minimal Razorpay client surface this module uses, so tests can inject a mock. */
export interface RazorpayGatewayLike {
  orders: { fetch(id: string): Promise<{ id: string; amount: number; currency: string }> };
  payments: {
    fetch(id: string): Promise<{ id: string; amount: number; currency: string; status: string }>;
  };
}

export interface PaymentVerifyDeps {
  /** Injected gateway (a test mock, or `null` to simulate "gateway not configured"). Defaults to the real client. */
  gateway?: RazorpayGatewayLike | null;
}

/** The captured payment as Razorpay reports it. */
export interface RazorpayPaymentLike {
  id: string;
  amount: number;
  currency: string;
  status: string;
}

function resolveGateway(deps?: PaymentVerifyDeps): RazorpayGatewayLike {
  // Fail CLOSED: an unconfigured gateway must never silently pass a payment check.
  // Signature verification already throws for unconfigured gateways, so this is consistent.
  // Note: `deps.gateway` may be explicitly `null` (tests simulating "not configured"),
  // so the presence of the key — not nullish coalescing — decides the override.
  const gateway = deps && 'gateway' in deps ? deps.gateway : (razorpay as unknown as RazorpayGatewayLike | null);
  if (!gateway) throw badRequest('Payment gateway not configured.');
  return gateway;
}

/** Fetches one Razorpay payment by id. Throws when the gateway is not configured. */
export async function fetchRazorpayPayment(razorpayPaymentId: string, deps?: PaymentVerifyDeps): Promise<RazorpayPaymentLike> {
  const gateway = resolveGateway(deps);
  let payment: RazorpayPaymentLike;
  try {
    payment = await gateway.payments.fetch(razorpayPaymentId);
  } catch {
    throw badRequest('Could not verify payment. Do not retry — contact support.', [{ path: 'razorpayPaymentId', message: 'Payment lookup failed.' }]);
  }
  return {
    id: String(payment.id),
    amount: Number(payment.amount),
    currency: String(payment.currency).toUpperCase(),
    status: String(payment.status),
  };
}

/**
 * Verifies a CAPTURED payment, not just the Razorpay order (H3): the order amount
 * only proves an order was created for that amount — the payment itself may have
 * failed, expired, or been for a different amount. Requires status 'captured' and
 * an exact amount/currency match against the server-computed remainder.
 */
export async function verifyCapturedPayment(
  razorpayPaymentId: string,
  expectedAmount: number,
  expectedCurrency: string,
  deps?: PaymentVerifyDeps,
): Promise<void> {
  const payment = await fetchRazorpayPayment(razorpayPaymentId, deps);
  if (payment.status !== 'captured') {
    throw badRequest('Payment was not captured. Do not retry — contact support.', [{ path: 'razorpayPaymentId', message: `Payment status is '${payment.status}', not 'captured'.` }]);
  }
  if (payment.currency !== expectedCurrency.toUpperCase()) {
    throw badRequest('Payment currency mismatch. Do not retry — contact support.', [{ path: 'razorpayPaymentId', message: `Expected ${expectedCurrency}, got ${payment.currency}.` }]);
  }
  if (payment.amount !== Math.round(expectedAmount)) {
    throw badRequest('Payment amount mismatch. Do not retry — contact support.', [{ path: 'razorpayPaymentId', message: `Expected ${Math.round(expectedAmount)}, got ${payment.amount}.` }]);
  }
}

/**
 * Fetches the Razorpay order and asserts that its captured amount and currency match the
 * server-computed total. Prevents a crafted flow where a client creates a cheap Razorpay order
 * externally and then sends its signature for a higher-value store order.
 *
 * Fail-closed (H3): when Razorpay is not configured this THROWS instead of silently
 * passing — a payment check that cannot run must never report success.
 */
export async function verifyRazorpayOrderAmount(
  razorpayOrderId: string,
  expectedAmount: number,
  expectedCurrency: string,
  deps?: PaymentVerifyDeps,
): Promise<void> {
  const gateway = resolveGateway(deps);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let rzpOrder: any;
  try {
    rzpOrder = await gateway.orders.fetch(razorpayOrderId);
  } catch {
    throw badRequest('Could not verify payment order. Do not retry — contact support.', [{ path: 'razorpayOrderId', message: 'Order lookup failed.' }]);
  }
  const capturedAmount = Number(rzpOrder.amount);
  const capturedCurrency = String(rzpOrder.currency).toUpperCase();
  if (capturedCurrency !== expectedCurrency.toUpperCase()) {
    throw badRequest('Payment currency mismatch. Do not retry — contact support.', [{ path: 'razorpayOrderId', message: `Expected ${expectedCurrency}, got ${capturedCurrency}.` }]);
  }
  if (capturedAmount !== Math.round(expectedAmount)) {
    throw badRequest('Payment amount mismatch. Do not retry — contact support.', [{ path: 'razorpayOrderId', message: `Expected ${Math.round(expectedAmount)}, got ${capturedAmount}.` }]);
  }
}

/** Initial payment status. Every order is prepaid (signature already verified), so all new orders start 'paid'. */
export function initialPaymentStatus(_method: PaymentMethod): 'paid' {
  return 'paid';
}
