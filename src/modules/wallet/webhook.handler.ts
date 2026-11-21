import type { Request, Response } from 'express';
import { verifyRazorpayWebhookSignature } from '../../shared/utils/webhook.js';
import { errorMessage, logger } from '../../shared/observability/logger.js';
import { handleTopupWebhook, markTopupFailed } from './wallet-topup.service.js';

// Mount path: POST /api/webhooks/wallet/razorpay
// IMPORTANT: This route must be mounted BEFORE requireCsrf in app.ts.
// It uses express.raw({ type: 'application/json' }) for body parsing to verify the HMAC signature.
// A DB error returns 500 so Razorpay retries the delivery instead of dropping it.

export async function handleWalletRazorpayWebhook(req: Request, res: Response): Promise<void> {
  const signature = String(req.headers['x-razorpay-signature'] ?? '');
  const rawBody = req.body as Buffer;

  if (!verifyRazorpayWebhookSignature(rawBody, signature)) {
    res.status(400).json({ error: { message: 'Invalid webhook signature.' } });
    return;
  }

  let event: { event: string; payload?: { payment?: { entity?: { id?: string; order_id?: string } } } };
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    res.status(400).json({ error: { message: 'Invalid JSON payload.' } });
    return;
  }

  // payment.captured credits the top-up (amount-verified in the service); payment.failed
  // marks the matching top-up failed so it can never be credited by a later verify call.
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
      const result = await markTopupFailed(orderId, paymentId);
      res.json(result);
      return;
    }
    const result = await handleTopupWebhook(orderId, paymentId);
    res.json(result);
  } catch (err) {
    logger.error('wallet webhook failed', { requestId: req.requestId ?? null, error: errorMessage(err) });
    res.status(500).json({ error: { message: 'Internal error processing webhook.' } });
  }
}
