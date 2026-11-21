// Unit tests for newsletter subscribe/unsubscribe (M14). Prisma is mocked — these verify
// the service calls the right query with the right data, not the database itself.
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
  process.env.JWT_SECRET ??= 'test-only-jwt-secret-0123456789';
  return {
    newsletterSubscriber: {
      upsert: vi.fn().mockResolvedValue({ id: 'n_1' }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
});
vi.mock('../../../shared/database/prisma.js', () => ({ prisma: { newsletterSubscriber: mocks.newsletterSubscriber } }));

import { subscribeToNewsletter, unsubscribeFromNewsletter } from '../newsletter.service.js';

describe('subscribeToNewsletter', () => {
  it('upserts and clears unsubscribedAt (re-activation on re-subscribe)', async () => {
    await expect(subscribeToNewsletter({ email: 'a@example.com' })).resolves.toEqual({ ok: true });
    expect(mocks.newsletterSubscriber.upsert).toHaveBeenCalledWith({
      where: { email: 'a@example.com' },
      update: { unsubscribedAt: null },
      create: { email: 'a@example.com' },
    });
  });
});

describe('unsubscribeFromNewsletter', () => {
  it('sets unsubscribedAt for a known email and returns ok', async () => {
    await expect(unsubscribeFromNewsletter({ email: 'a@example.com' })).resolves.toEqual({ ok: true });
    const call = mocks.newsletterSubscriber.updateMany.mock.calls[0]?.[0] as {
      where: { email: string };
      data: { unsubscribedAt: Date };
    };
    expect(call.where).toEqual({ email: 'a@example.com' });
    expect(call.data.unsubscribedAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('returns ok even when the email was never subscribed (no enumeration)', async () => {
    mocks.newsletterSubscriber.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(unsubscribeFromNewsletter({ email: 'nobody@example.com' })).resolves.toEqual({ ok: true });
  });
});
