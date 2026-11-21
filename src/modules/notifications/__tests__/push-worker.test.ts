// Unit tests for the cron-secret check (L8/M1): the comparison must be constant-time,
// which here means equal-length buffers compared with timingSafeEqual — a wrong secret of
// a different length must fail on the length check, and an equal-length wrong secret must
// fail on the content check. (Timing itself cannot be asserted in a unit test.)
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
  process.env.JWT_SECRET ??= 'test-only-jwt-secret-0123456789';
  process.env.CRON_SECRET ??= 'test-cron-secret-0123456789';
  return {};
});
void mocks;
vi.mock('../../../shared/database/prisma.js', () => ({ prisma: {} }));

import { validateCronSecret } from '../push.worker.js';

describe('validateCronSecret', () => {
  it('accepts the exact Bearer secret', () => {
    expect(validateCronSecret('Bearer test-cron-secret-0123456789')).toBe(true);
  });

  it('rejects a missing header', () => {
    expect(validateCronSecret(undefined)).toBe(false);
  });

  it('rejects a wrong secret of a different length', () => {
    expect(validateCronSecret('Bearer wrong')).toBe(false);
  });

  it('rejects a wrong secret of the same length', () => {
    expect(validateCronSecret('Bearer test-cron-secret-0123456780')).toBe(false);
  });

  it('rejects the bare secret without the Bearer prefix', () => {
    expect(validateCronSecret('test-cron-secret-0123456789')).toBe(false);
  });
});
