import { prisma } from '../../shared/database/prisma.js';
import type { NewsletterSubscribeInput } from './newsletter.schema.js';

/**
 * Stores a newsletter subscription. Idempotent: subscribing the same email twice returns
 * success and re-activates a previously unsubscribed row instead of erroring, so the
 * footer form never shows a spurious failure for an existing subscriber.
 */
export async function subscribeToNewsletter({ email }: NewsletterSubscribeInput): Promise<{ ok: true }> {
  await prisma.newsletterSubscriber.upsert({
    where: { email },
    update: { unsubscribedAt: null },
    create: { email },
  });
  return { ok: true };
}

/**
 * Unsubscribes an email. Always returns ok — including for unknown emails — so the
 * endpoint cannot be used to discover which emails are subscribed.
 */
export async function unsubscribeFromNewsletter({ email }: NewsletterSubscribeInput): Promise<{ ok: true }> {
  await prisma.newsletterSubscriber.updateMany({
    where: { email },
    data: { unsubscribedAt: new Date() },
  });
  return { ok: true };
}
