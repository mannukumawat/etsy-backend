// Mount path: POST /api/webhooks/orders/razorpay
// IMPORTANT: This route must be mounted BEFORE requireCsrf in app.ts (like the wallet
// webhook). It uses express.raw({ type: 'application/json' }) for body parsing to
// verify the HMAC signature.
//
// Paid-but-no-order (H5): Razorpay retries webhooks, so this is the reliable second
// witness for a capture. If the payment already belongs to an order, it is just
// acknowledged. If it does not, it is recorded as an unmatched payment recovery for
// the owner to resolve — the webhook payload has no cart/address/totals, so no order
// can be rebuilt from it safely. When RAZORPAY_WEBHOOK_SECRET is not configured the
// webhook cannot be verified and is rejected: an unverified "payment captured" must
// never create a recovery row an attacker could forge.
//
// A DB error returns 500 so Razorpay retries the delivery instead of dropping it.
import type { Request, Response } from 'express';
import { verifyRazorpayWebhookSignature } from '../../shared/utils/webhook.js';
import { errorMessage, logger } from '../../shared/observability/logger.js';
import { recordCapturedPayment, recordFailedPayment } from './payment-recovery.service.js';

interface RazorpayPaymentEntity {
  id?: string;
  order_id?: string;
  amount?: number;
  currency?: string;
  email?: string;
}

export async function handleOrderRazorpayWebhook(req: Request, res: Response): Promise<void> {
  const signature = String(req.headers['x-razorpay-signature'] ?? '');
  const rawBody = req.body as Buffer;

  if (!verifyRazorpayWebhookSignature(rawBody, signature)) {
    res.status(400).json({ error: { message: 'Invalid webhook signature.' } });
    return;
  }

  let event: { event: string; payload?: { payment?: { entity?: RazorpayPaymentEntity } } };
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    res.status(400).json({ error: { message: 'Invalid JSON payload.' } });
    return;
  }

  // Only payment.captured and payment.failed carry reconciliation work. Failed
  // payments never charged the customer, so there is no recovery row — but an order
  // that exists for a failed payment must be marked failed (see recordFailedPayment).
  if (event.event !== 'payment.captured' && event.event !== 'payment.failed') {
    res.json({ status: 'ignored' });
    return;
  }

  const payment = event.payload?.payment?.entity;
  const paymentId = payment?.id;
  const orderId = payment?.order_id;
  if (!paymentId || !orderId) {
    res.status(400).json({ error: { message: 'Missing payment details in webhook.' } });
    return;
  }

  try {
    if (event.event === 'payment.failed') {
      const result = await recordFailedPayment({ razorpayPaymentId: paymentId, razorpayOrderId: orderId });
      res.json(result.matched ? { status: 'recorded', orderNumber: result.orderNumber, markedFailed: result.markedFailed } : { status: 'ignored' });
      return;
    }
    const result = await recordCapturedPayment({
      razorpayPaymentId: paymentId,
      razorpayOrderId: orderId,
      amount: Number(payment.amount ?? 0),
      currency: String(payment.currency ?? '').toUpperCase(),
      customerEmail: payment.email ?? null,
    });
    res.json(result.matched ? { status: 'matched', orderNumber: result.orderNumber } : { status: 'recorded', recoveryId: result.recoveryId });
  } catch (err) {
    logger.error('order webhook failed', { requestId: req.requestId ?? null, error: errorMessage(err) });
    res.status(500).json({ error: { message: 'Internal error processing webhook.' } });
  }
}
