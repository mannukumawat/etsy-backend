// Shared Razorpay webhook signature check (H5): both the wallet top-up webhook and
// the order-payment webhook verify the same way — one helper so the HMAC construction
// can never drift between them. Returns false when no secret is configured, so an
// unverifiable webhook is always rejected instead of trusted.
import crypto from 'node:crypto';
import { env } from '../config/env.js';

/** HMAC-SHA256 of the raw request body, compared in constant time. */
export function verifyRazorpayWebhookSignature(rawBody: Buffer, signature: string): boolean {
  const secret = env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const given = Buffer.from(signature, 'utf8');
  const want = Buffer.from(expected, 'utf8');
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}
