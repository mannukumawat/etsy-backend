// Server-side JWT revocation (M15).
//
// Every session JWT carries a `jti` (random UUID) plus per-realm `iss`/`aud` claims, so a
// token can be individually revoked at logout / password change without invalidating every
// other session. Revoked jtis are stored hashed (SHA-256) in `revoked_sessions` — the raw
// jti never touches the database, and the hash column is `@unique`, so every check below
// is a single indexed lookup, never a table scan.
//
// Limits, stated honestly: a `jti` identifies ONE token. Password change revokes only the
// current token's jti (the caller passes the session cookie it holds); other live sessions
// for the same user cannot be enumerated from here. A full "revoke all sessions" needs a
// per-user session-version column — a follow-up, not something this list can do.
import { createHash } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { prisma } from '../database/prisma.js';

export const OWNER_ISSUER = 'your-store-owner';
export const CUSTOMER_ISSUER = 'your-store-customer';
export const TOKEN_AUDIENCE = 'your-store';

export type SessionRealm = 'owner' | 'customer';

/** SHA-256 hex of a jti — the only form ever stored or queried. Pure: unit-testable. */
export function hashJti(jti: string): string {
  return createHash('sha256').update(jti).digest('hex');
}

/** Revoke one token id until `expiresAt`. Idempotent: re-revoking the same jti is a no-op. */
export async function revokeByJti(jti: string, realm: SessionRealm, expiresAt: Date): Promise<void> {
  await prisma.revokedSession.upsert({
    where: { jtiHash: hashJti(jti) },
    create: { jtiHash: hashJti(jti), realm, expiresAt },
    update: { expiresAt },
  });
}

/**
 * Revoke a raw session JWT by decoding its `jti`/`exp` claims. Returns false when the
 * token carries no `jti` (legacy pre-revocation tokens) or cannot be decoded — there is
 * nothing to revoke in either case. The token is NOT signature-verified here: revoking
 * only adds a hash to the denylist, and an attacker who holds the raw token already has
 * the session, so verification would add nothing.
 */
export async function revokeToken(rawToken: string, realm: SessionRealm): Promise<boolean> {
  const decoded = jwt.decode(rawToken) as { jti?: string; exp?: number } | null;
  if (!decoded || typeof decoded.jti !== 'string' || !decoded.jti) return false;
  const ttlHours = realm === 'owner' ? env.SESSION_TTL_HOURS : env.CUSTOMER_SESSION_TTL_HOURS;
  const expiresAt = typeof decoded.exp === 'number'
    ? new Date(decoded.exp * 1000)
    : new Date(Date.now() + ttlHours * 60 * 60 * 1000);
  await revokeByJti(decoded.jti, realm, expiresAt);
  return true;
}

/** Single indexed lookup on the `@unique` jtiHash column. */
export async function isRevoked(jti: string): Promise<boolean> {
  const row = await prisma.revokedSession.findUnique({ where: { jtiHash: hashJti(jti) }, select: { id: true } });
  return row !== null;
}

/**
 * Delete revocation rows whose tokens have already expired — they can never match a live
 * token again. Best-effort housekeeping: callers fire-and-forget this and ignore failures.
 */
export async function sweepExpiredRevocations(): Promise<number> {
  const result = await prisma.revokedSession.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return result.count;
}
