import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { env } from '../../shared/config/env.js';
import { handleTopupWebhook } from './wallet-topup.service.js';

// Mount path: POST /api/webhooks/wallet/razorpay
// IMPORTANT: This route must be mounted BEFORE requireCsrf in app.ts.
// It uses express.raw({ type: 'application/json' }) for body parsing to verify the HMAC signature.

/** Verifies a Razorpay webhook signature for wallet events. */
function verifyWebhookSignature(rawBody: Buffer, signature: string): boolean {
  if (!env.RAZORPAY_WEBHOOK_SECRET) return false;
  const expected = crypto
    .createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  return expected === signature;
}

export async function handleWalletRazorpayWebhook(req: Request, res: Response): Promise<void> {
  const signature = String(req.headers['x-razorpay-signature'] ?? '');
  const rawBody = req.body as Buffer;

  if (!verifyWebhookSignature(rawBody, signature)) {
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

  // Only handle payment.captured events
  if (event.event !== 'payment.captured') {
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
    const result = await handleTopupWebhook(orderId, paymentId);
    res.json(result);
  } catch (err) {
    console.error('[wallet webhook] Error processing topup webhook:', err);
    res.status(500).json({ error: { message: 'Internal error processing webhook.' } });
  }
}
