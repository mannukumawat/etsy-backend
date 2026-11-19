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

/** Verifies that the payment signature from Razorpay is genuine. Throws 400 on tampered data. */
export function verifyRazorpaySignature(razorpayOrderId: string, razorpayPaymentId: string, signature: string) {
  if (!env.RAZORPAY_KEY_SECRET) throw badRequest('Payment gateway not configured.');
  const expected = crypto
    .createHmac('sha256', env.RAZORPAY_KEY_SECRET)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest('hex');
  if (expected !== signature) throw badRequest('Payment verification failed. Do not retry — contact support.', [{ path: 'razorpaySignature', message: 'Invalid signature.' }]);
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
 * Fetches the Razorpay order and asserts that its captured amount and currency match the
 * server-computed total. Prevents a crafted flow where a client creates a cheap Razorpay order
 * externally and then sends its signature for a higher-value store order.
 *
 * When Razorpay is not configured (dev/test without credentials), this is a no-op — the caller
 * is expected to note which provider checks remain pending in this environment.
 */
export async function verifyRazorpayOrderAmount(razorpayOrderId: string, expectedAmount: number, expectedCurrency: string): Promise<void> {
  if (!razorpay) return; // No gateway configured — skip; callers must note this in test reports.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let rzpOrder: any;
  try {
    rzpOrder = await razorpay.orders.fetch(razorpayOrderId);
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

/** Initial payment status. All gateway payments = paid (signature already verified). */
export function initialPaymentStatus(_method: PaymentMethod): 'paid' {
  return 'paid';
}
