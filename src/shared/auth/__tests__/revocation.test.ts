// Unit tests for the server-side JWT revocation list (M15). The Prisma client cannot be
// generated in this environment, so the database is mocked — these tests verify the
// helper logic (hashing, upsert/findUnique/deleteMany calls, token decoding) only.
// The DB-backed behaviour (unique jtiHash lookup, row expiry) is covered by the schema.
import { createHash } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
  process.env.JWT_SECRET ??= 'test-only-jwt-secret-0123456789';
  return {
    revokedSession: {
      upsert: vi.fn().mockResolvedValue({ id: 'rev_1' }),
      findUnique: vi.fn().mockResolvedValue(null),
      deleteMany: vi.fn().mockResolvedValue({ count: 3 }),
    },
  };
});
vi.mock('../../database/prisma.js', () => ({ prisma: { revokedSession: mocks.revokedSession } }));

import { hashJti, isRevoked, revokeByJti, revokeToken, sweepExpiredRevocations } from '../revocation.js';

describe('hashJti', () => {
  it('is the SHA-256 hex of the jti (64 hex chars, deterministic)', () => {
    expect(hashJti('jti-abc')).toBe(createHash('sha256').update('jti-abc').digest('hex'));
    expect(hashJti('jti-abc')).toHaveLength(64);
    expect(hashJti('jti-abc')).not.toBe(hashJti('jti-def'));
  });

  it('never returns the raw jti', () => {
    expect(hashJti('secret-jti-value')).not.toContain('secret-jti-value');
  });
});

describe('revokeByJti', () => {
  it('upserts the hashed jti with realm and expiry (idempotent re-revoke)', async () => {
    const expiresAt = new Date('2030-01-01T00:00:00Z');
    await revokeByJti('jti-1', 'customer', expiresAt);
    expect(mocks.revokedSession.upsert).toHaveBeenCalledWith({
      where: { jtiHash: hashJti('jti-1') },
      create: { jtiHash: hashJti('jti-1'), realm: 'customer', expiresAt },
      update: { expiresAt },
    });
  });
});

describe('isRevoked', () => {
  it('returns true when a row exists for the hashed jti', async () => {
    mocks.revokedSession.findUnique.mockResolvedValueOnce({ id: 'rev_1' });
    await expect(isRevoked('jti-1')).resolves.toBe(true);
    expect(mocks.revokedSession.findUnique).toHaveBeenCalledWith({
      where: { jtiHash: hashJti('jti-1') },
      select: { id: true },
    });
  });

  it('returns false when no row exists (single indexed lookup)', async () => {
    mocks.revokedSession.findUnique.mockResolvedValueOnce(null);
    await expect(isRevoked('jti-unknown')).resolves.toBe(false);
  });
});

describe('revokeToken', () => {
  it('revokes a signed token by its jti, expiring with the token', async () => {
    const token = jwt.sign({ sub: 'cust_1' }, 'test-only-jwt-secret-0123456789', {
      expiresIn: '1h',
      jwtid: 'jti-token-1',
    });
    await expect(revokeToken(token, 'customer')).resolves.toBe(true);
    const call = mocks.revokedSession.upsert.mock.calls.at(-1)?.[0] as {
      create: { jtiHash: string; realm: string; expiresAt: Date };
    };
    expect(call.create.jtiHash).toBe(hashJti('jti-token-1'));
    expect(call.create.realm).toBe('customer');
    // exp is ~1h from now — within a 2-minute tolerance of the expected value.
    expect(Math.abs(call.create.expiresAt.getTime() - (Date.now() + 60 * 60 * 1000))).toBeLessThan(120_000);
  });

  it('returns false for a legacy token without a jti (nothing to revoke)', async () => {
    const token = jwt.sign({ sub: 'cust_1' }, 'test-only-jwt-secret-0123456789', { expiresIn: '1h' });
    await expect(revokeToken(token, 'customer')).resolves.toBe(false);
  });

  it('returns false for a token that cannot be decoded', async () => {
    await expect(revokeToken('not-a-jwt', 'owner')).resolves.toBe(false);
  });
});

describe('sweepExpiredRevocations', () => {
  it('deletes rows whose tokens already expired and returns the count', async () => {
    await expect(sweepExpiredRevocations()).resolves.toBe(3);
    const where = mocks.revokedSession.deleteMany.mock.calls[0]?.[0]?.where as { expiresAt: { lt: Date } };
    expect(where.expiresAt.lt.getTime()).toBeLessThanOrEqual(Date.now());
  });
});
