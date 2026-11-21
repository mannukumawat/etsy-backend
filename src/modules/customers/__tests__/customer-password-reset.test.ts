import bcrypt from 'bcryptjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hermetic tests for the customer password reset after the shared-helper move (C5/DRY):
// the customer flow must keep working exactly as before while reusing
// shared/utils/crypto.ts (newResetToken / RESET_TOKEN_TTL_MS / sha256Hex).

const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
  process.env.JWT_SECRET ??= 'test-only-jwt-secret-0123456789';
  return {
    prisma: {
      customer: { findUnique: vi.fn(), update: vi.fn() },
      passwordResetToken: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
      $transaction: vi.fn(async (ops: unknown[]) => ops),
    },
    sendMail: vi.fn(),
  };
});
vi.mock('../../../shared/database/prisma.js', () => ({ prisma: mocks.prisma, assertDatabaseReachable: vi.fn() }));
vi.mock('../../../shared/mail/mailer.js', () => ({ sendMail: mocks.sendMail }));

import { confirmPasswordReset, requestPasswordReset } from '../customer-auth.service.js';

const { prisma, sendMail } = mocks;
const CUSTOMER = { id: 'cust_test', email: 'customer@test.example', name: 'Test Customer' };

beforeEach(() => {
  vi.clearAllMocks();
  sendMail.mockResolvedValue({ delivered: true });
});

describe('customer requestPasswordReset (shared helper)', () => {
  it('creates a hashed token with a 1-hour expiry and emails the storefront link', async () => {
    prisma.customer.findUnique.mockResolvedValue(CUSTOMER);
    await requestPasswordReset('  Customer@Test.Example ');

    const create = prisma.passwordResetToken.create.mock.calls[0][0].data;
    expect(create.customerId).toBe(CUSTOMER.id);
    expect(create.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(create.expiresAt.getTime() - Date.now()).toBeGreaterThan(59 * 60 * 1000);
    expect(sendMail.mock.calls[0][0]).toBe(CUSTOMER.email);
    expect(sendMail.mock.calls[0][1]).toMatch(/reset/i);
  });

  it('stays silent for an unknown email', async () => {
    prisma.customer.findUnique.mockResolvedValue(null);
    await requestPasswordReset('ghost@example.com');
    expect(prisma.passwordResetToken.create).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });
});

describe('customer confirmPasswordReset (shared helper)', () => {
  it('sets the new password and marks the token used', async () => {
    prisma.passwordResetToken.findUnique.mockResolvedValue({
      id: 'tok1', customerId: CUSTOMER.id, tokenHash: 'abc', expiresAt: new Date(Date.now() + 60000), usedAt: null,
    });
    await confirmPasswordReset('raw-token', 'NewCustomerPass123');

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const ops = prisma.$transaction.mock.calls[0][0] as unknown[];
    expect(ops).toHaveLength(3);
    // The customer update carries a bcrypt hash of the new password.
    expect(prisma.customer.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: CUSTOMER.id } }),
    );
    const hash = prisma.customer.update.mock.calls[0][0].data.passwordHash as string;
    expect(await bcrypt.compare('NewCustomerPass123', hash)).toBe(true);
  });

  it('rejects an expired token', async () => {
    prisma.passwordResetToken.findUnique.mockResolvedValue({
      id: 'tok1', customerId: CUSTOMER.id, tokenHash: 'abc', expiresAt: new Date(Date.now() - 1000), usedAt: null,
    });
    await expect(confirmPasswordReset('raw-token', 'NewCustomerPass123')).rejects.toThrow('invalid or has expired');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
