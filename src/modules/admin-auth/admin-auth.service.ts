import bcrypt from 'bcryptjs';
import type { Response } from 'express';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { env } from '../../shared/config/env.js';
import { prisma } from '../../shared/database/prisma.js';
import { OWNER_ISSUER, TOKEN_AUDIENCE, revokeToken, sweepExpiredRevocations } from '../../shared/auth/revocation.js';
import { clearCsrfCookie, issueCsrfCookie } from '../../shared/middleware/csrf.middleware.js';
import { OWNER_SESSION_COOKIE, type OwnerClaims } from '../../shared/middleware/auth.middleware.js';

export function issueSession(res: Response, owner: { id: string; email: string; name: string }) {
  const token = jwt.sign({ sub: owner.id, email: owner.email, name: owner.name } satisfies OwnerClaims, env.JWT_SECRET, {
    expiresIn: `${env.SESSION_TTL_HOURS}h`,
    // M15: per-realm issuer/audience plus a per-token id, so this token can be
    // individually revoked (see revocation.ts) and can never replay as a customer token.
    issuer: OWNER_ISSUER,
    audience: TOKEN_AUDIENCE,
    jwtid: randomUUID(),
  });
  res.cookie(OWNER_SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.isProd,
    maxAge: env.SESSION_TTL_HOURS * 60 * 60 * 1000,
    path: '/',
    domain: env.cookieDomain,
  });
  const csrfToken = issueCsrfCookie(res, env.SESSION_TTL_HOURS * 60 * 60 * 1000);
  return { token, csrfToken };
}

/**
 * Clears the owner session cookie. When the caller passes the raw session token (the
 * `ys_owner_session` cookie value — see the logout route), the token is revoked
 * server-side so it cannot be replayed after logout, and expired revocation rows are
 * swept opportunistically. Revocation is best-effort: a failure never blocks logout.
 */
export function clearSession(res: Response, rawToken?: string) {
  if (rawToken) void revokeToken(rawToken, 'owner').catch(() => {});
  void sweepExpiredRevocations().catch(() => {});
  res.clearCookie(OWNER_SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.isProd,
    path: '/',
    domain: env.cookieDomain,
  });
  clearCsrfCookie(res);
}

export async function verifyOwnerCredentials(email: string, password: string) {
  const normalizedEmail = email.trim().toLowerCase();
  const owner = await prisma.owner.findUnique({ where: { email: normalizedEmail } });
  if (owner && (await bcrypt.compare(password, owner.passwordHash))) return owner;

  // Production recovery/bootstrap: the deploy-time owner secrets are authoritative when explicitly
  // configured. This lets a single-seller deployment recover from a stale seeded password without
  // direct database access. The values come from the validated env schema (env.ts): in
  // production OWNER_PASSWORD must be explicitly set (startup fails otherwise — see H10), so a
  // forgotten deploy can never make a default password a production back door. In dev/test the
  // default matches the seeded owner password, so no new access is granted there either.
  const configuredEmail = env.OWNER_EMAIL.trim().toLowerCase();
  const configuredPassword = env.OWNER_PASSWORD;
  if (!configuredEmail || !configuredPassword || normalizedEmail !== configuredEmail || password !== configuredPassword) return null;

  const passwordHash = await bcrypt.hash(configuredPassword, 10);
  if (owner) {
    return prisma.owner.update({
      where: { id: owner.id },
      data: { passwordHash, name: env.OWNER_NAME.trim() || owner.name },
    });
  }

  // This is a single-owner store. If an earlier seed used another email, migrate that row instead of
  // silently creating a second administrator.
  const existingOwner = await prisma.owner.findFirst({ orderBy: { createdAt: 'asc' } });
  if (existingOwner) {
    return prisma.owner.update({
      where: { id: existingOwner.id },
      data: { email: configuredEmail, passwordHash, name: env.OWNER_NAME.trim() || existingOwner.name },
    });
  }

  return prisma.owner.create({
    data: {
      id: `owner_${Date.now().toString(36)}`,
      email: configuredEmail,
      passwordHash,
      name: env.OWNER_NAME.trim() || 'Store_Owner',
    },
  });
}
