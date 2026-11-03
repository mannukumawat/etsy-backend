import { badRequest } from './http.js';
import { env, isPaymentGatewayConfigured, paymentGatewaySetupHelp } from './env.js';

// No real gateway credentials exist for this store yet. Cash-on-delivery is a fully real payment
// method (status genuinely reflects "will be collected on delivery", never faked as "paid"). Card,
// UPI and wallet are modelled end to end (schema, validation, admin UI) but are REJECTED at checkout
// until a real gateway is configured — the payment/refund status must reflect a verified provider
// result, and with no provider there is nothing to verify.

export type PaymentMethod = 'cod' | 'card' | 'upi' | 'wallet';

export function assertPaymentMethodAvailable(method: PaymentMethod) {
  if (method === 'cod') return;
  if (!isPaymentGatewayConfigured) {
    throw badRequest(
      `${method.toUpperCase()} payment is not available yet: no payment gateway is configured. ${paymentGatewaySetupHelp} Use Cash on Delivery for now.`,
      [{ path: 'paymentMethod', message: 'Payment gateway not configured.' }],
    );
  }
  // A real integration would create a provider payment intent/order here and return its reference.
  // With PAYMENT_GATEWAY set but this path unimplemented for the specific provider, fail loudly
  // rather than silently proceeding as if payment succeeded.
  throw badRequest(
    `${env.PAYMENT_GATEWAY} is configured but its checkout integration is not implemented yet. Use Cash on Delivery for now.`,
    [{ path: 'paymentMethod', message: 'Gateway integration not implemented.' }],
  );
}

/** Initial payment status for a newly placed order. COD is "unpaid" until the owner marks it paid on
 *  delivery; no other method can reach order creation without a working gateway (see above). */
export function initialPaymentStatus(_method: PaymentMethod): 'unpaid' {
  return 'unpaid';
}
