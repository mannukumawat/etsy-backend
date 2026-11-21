import bcrypt from 'bcryptjs';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hermetic tests for the owner password reset (C5): Prisma and the mailer are mocked,
// no database is touched, no email is sent.

const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
  process.env.JWT_SECRET ??= 'test-only-jwt-secret-0123456789';
  return {
    prisma: {
      owner: { findUnique: vi.fn(), update: vi.fn() },
      $queryRawUnsafe: vi.fn(),
      $executeRawUnsafe: vi.fn(),
    },
    sendMail: vi.fn(),
  };
});
vi.mock('../../../shared/database/prisma.js', () => ({ prisma: mocks.prisma, assertDatabaseReachable: vi.fn() }));
// The generated Prisma client is absent in this environment (prisma generate is
// network-blocked); stub the two runtime value imports so createApp() can load.
vi.mock('@prisma/client', () => ({
  PrismaClient: class {},
  Prisma: { PrismaClientKnownRequestError: class extends Error { code?: string } },
}));
vi.mock('../../../shared/mail/mailer.js', () => ({ sendMail: mocks.sendMail }));

import { createApp } from '../../../app.js';
import { OWNER } from '../../../__tests__/support/owner-session.js';
import { requestPasswordReset, resetPassword } from '../password-reset.service.js';

const { prisma, sendMail } = mocks;
const app = createApp();

const findOwnerByEmail = async ({ where }: { where: { email: string } }) =>
  where.email === OWNER.email ? OWNER : null;

beforeEach(() => {
  vi.clearAllMocks();
  prisma.owner.findUnique.mockImplementation(findOwnerByEmail);
  sendMail.mockResolvedValue({ delivered: true });
});

describe('requestPasswordReset', () => {
  it('creates a hashed, expiring token and emails the reset link for a known owner', async () => {
    const result = await requestPasswordReset('  Owner@Test.Example ');

    expect(result).toMatchObject({ ok: true, delivered: true });
    // Only the hash is stored — never the raw token.
    const insert = prisma.$executeRawUnsafe.mock.calls[0];
    expect(insert[0]).toContain('INSERT INTO owner_password_reset_tokens');
    expect(insert[2]).toBe(OWNER.id);
    expect(insert[3]).toMatch(/^[0-9a-f]{64}$/);
    const expiresAt = insert[4] as Date;
    expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(59 * 60 * 1000);
    expect(expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(60 * 60 * 1000);
    // The emailed link carries the raw token and points at the admin app.
    const mail = sendMail.mock.calls[0];
    expect(mail[0]).toBe(OWNER.email);
    expect(mail[2]).toMatch(/http:\/\/localhost:5174\/reset-password\?token=[0-9a-f]{64}/);
  });

  it('answers exactly the same for an unknown email — no token, no mail, no enumeration', async () => {
    const result = await requestPasswordReset('nobody@example.com');

    expect(result).toEqual({ ok: true, delivered: false });
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('reports delivered:false when SMTP is not configured instead of faking success', async () => {
    sendMail.mockResolvedValue({ delivered: false, devPreview: { to: OWNER.email, subject: 'x', text: 'link' } });
    const result = await requestPasswordReset(OWNER.email);
    expect(result.delivered).toBe(false);
    expect(result.devPreview).toBeDefined();
  });
});

describe('resetPassword', () => {
  it('sets the new password hash and invalidates outstanding tokens', async () => {
    prisma.$queryRawUnsafe.mockResolvedValue([{ id: 'tok1', owner_id: OWNER.id, token_hash: 'abc', expires_at: new Date(Date.now() + 60000), used_at: null }]);
    const result = await resetPassword('raw-token-value', 'NewPassword123');

    expect(result).toEqual({ ok: true });
    const update = prisma.owner.update.mock.calls[0][0];
    expect(update.where).toEqual({ id: OWNER.id });
    expect(await bcrypt.compare('NewPassword123', update.data.passwordHash as string)).toBe(true);
    expect(prisma.$executeRawUnsafe).toHaveBeenCalledWith(expect.stringContaining('used_at = NOW(3)'), OWNER.id);
  });

  it('rejects an unknown or expired token', async () => {
    prisma.$queryRawUnsafe.mockResolvedValue([]);
    await expect(resetPassword('nope', 'NewPassword123')).rejects.toThrow('invalid or has expired');
    expect(prisma.owner.update).not.toHaveBeenCalled();
  });

  it('rejects a token that was already used (single-use)', async () => {
    prisma.$queryRawUnsafe
      .mockResolvedValueOnce([{ id: 'tok1', owner_id: OWNER.id, token_hash: 'abc', expires_at: new Date(Date.now() + 60000), used_at: null }])
      .mockResolvedValueOnce([]);
    await resetPassword('raw-token-value', 'NewPassword123');
    await expect(resetPassword('raw-token-value', 'AnotherPass123')).rejects.toThrow('invalid or has expired');
  });
});

describe('POST /api/admin/auth/forgot-password + /reset-password (routes)', () => {
  it('forgot-password answers 200 with delivered:false for an unknown email', async () => {
    const res = await request(app).post('/api/admin/auth/forgot-password').send({ email: 'ghost-one@example.com' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, delivered: false });
  });

  it('forgot-password answers 200 with delivered:true for the owner and sends the link', async () => {
    const res = await request(app).post('/api/admin/auth/forgot-password').send({ email: OWNER.email });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, delivered: true });
    expect(sendMail).toHaveBeenCalled();
  });

  it('reset-password rejects a garbage token with 400', async () => {
    prisma.$queryRawUnsafe.mockResolvedValue([]);
    const res = await request(app).post('/api/admin/auth/reset-password').send({ token: 'garbage', password: 'NewPassword123' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/invalid or has expired/);
  });

  it('reset-password rejects a short new password with 400', async () => {
    const res = await request(app).post('/api/admin/auth/reset-password').send({ token: 'x'.repeat(64), password: 'short' });
    expect(res.status).toBe(400);
  });
});
