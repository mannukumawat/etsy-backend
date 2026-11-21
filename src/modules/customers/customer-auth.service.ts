import bcrypt from 'bcryptjs';
import type { Response } from 'express';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { env } from '../../shared/config/env.js';
import { prisma } from '../../shared/database/prisma.js';
import { badRequest, conflict } from '../../shared/errors/http-error.js';
import { sendMail } from '../../shared/mail/mailer.js';
import { CUSTOMER_ISSUER, TOKEN_AUDIENCE, revokeToken, sweepExpiredRevocations } from '../../shared/auth/revocation.js';
import { clearCsrfCookie, CUSTOMER_CSRF_COOKIE, issueCsrfCookie } from '../../shared/middleware/csrf.middleware.js';
import { CUSTOMER_SESSION_COOKIE, type CustomerClaims } from '../../shared/middleware/customer-auth.middleware.js';
import { RESET_TOKEN_TTL_MS, newResetToken, sha256Hex } from '../../shared/utils/crypto.js';
import type { CustomerRegisterInput } from './customer.schema.js';

export const hashPassword = (plain: string) => bcrypt.hash(plain, 10);

export function issueCustomerSession(res: Response, customer: { id: string; email: string; name: string }) {
  const token = jwt.sign({ sub: customer.id, email: customer.email, name: customer.name } satisfies CustomerClaims, env.JWT_SECRET, {
    expiresIn: `${env.CUSTOMER_SESSION_TTL_HOURS}h`,
    // M15: per-realm issuer/audience plus a per-token id, so this token can be
    // individually revoked (see revocation.ts) and can never replay as an owner token.
    issuer: CUSTOMER_ISSUER,
    audience: TOKEN_AUDIENCE,
    jwtid: randomUUID(),
  });
  res.cookie(CUSTOMER_SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: env.isProd ? 'none' : 'lax',
    secure: env.isProd,
    maxAge: env.CUSTOMER_SESSION_TTL_HOURS * 60 * 60 * 1000,
    path: '/',
  });
  return issueCsrfCookie(res, env.CUSTOMER_SESSION_TTL_HOURS * 60 * 60 * 1000, CUSTOMER_CSRF_COOKIE);
}

/**
 * Clears the customer session cookie. When the caller passes the raw session token (the
 * `ys_customer_session` cookie value — see the logout route), the token is revoked
 * server-side so it cannot be replayed after logout, and expired revocation rows are
 * swept opportunistically. Revocation is best-effort: a failure never blocks logout.
 */
export function clearCustomerSession(res: Response, rawToken?: string) {
  if (rawToken) void revokeToken(rawToken, 'customer').catch(() => {});
  void sweepExpiredRevocations().catch(() => {});
  res.clearCookie(CUSTOMER_SESSION_COOKIE, { httpOnly: true, sameSite: env.isProd ? 'none' : 'lax', secure: env.isProd, path: '/' });
  clearCsrfCookie(res, CUSTOMER_CSRF_COOKIE);
}

export async function verifyCustomerCredentials(email: string, password: string) {
  const customer = await prisma.customer.findUnique({ where: { email: email.trim().toLowerCase() } });
  if (!customer) return null;
  // Account in 14-day grace period → reactivate on successful login
  if (customer.deletedAt && customer.deletedAt > new Date()) {
    const ok = await bcrypt.compare(password, customer.passwordHash);
    if (!ok) return null;
    return prisma.customer.update({ where: { id: customer.id }, data: { deletedAt: null } });
  }
  // Past grace period → permanently inaccessible
  if (customer.deletedAt) return null;
  const ok = await bcrypt.compare(password, customer.passwordHash);
  return ok ? customer : null;
}

export async function registerCustomer(input: CustomerRegisterInput) {
  const email = input.email.trim().toLowerCase();
  const existing = await prisma.customer.findUnique({ where: { email } });
  if (existing) throw conflict('An account with this email already exists.', [{ path: 'email', message: 'Already registered.' }]);
  return prisma.customer.create({
    data: { name: input.name.trim(), email, phone: input.phone ?? '', passwordHash: await hashPassword(input.password) },
  });
}

/** Issues a one-hour reset link for the account, if there is one. Silent for unknown emails so the
 *  endpoint cannot be used to discover which emails have accounts. */
export async function requestPasswordReset(email: string): Promise<void> {
  const customer = await prisma.customer.findUnique({ where: { email: email.trim().toLowerCase() } });
  if (!customer) return;
  const { token, tokenHash } = newResetToken();
  await prisma.passwordResetToken.create({
    data: { customerId: customer.id, tokenHash, expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS) },
  });
  const resetUrl = `${env.STOREFRONT_PUBLIC_URL.replace(/\/$/, '')}/reset-password?token=${token}`;
  await sendMail(customer.email, 'Reset your password', `Reset your password: ${resetUrl}\n\nThis link expires in 1 hour. If you didn't request this, ignore this email.`);
}

/**
 * Consumes a reset token and sets the new password. When the caller passes the current
 * session token (`currentSessionToken`, the `ys_customer_session` cookie value — see the
 * reset-confirm route), that token is revoked so the pre-change session cannot be reused.
 * Only the CURRENT token can be revoked this way: a jti identifies one token, and there
 * is no way to enumerate the user's other live sessions from here. A full "revoke all
 * sessions" needs a per-user session-version column — a follow-up, not this function.
 * Revocation failure never fails the password change.
 */
export async function confirmPasswordReset(token: string, password: string, currentSessionToken?: string): Promise<void> {
  const row = await prisma.passwordResetToken.findUnique({ where: { tokenHash: sha256Hex(token) } });
  if (!row || row.usedAt || row.expiresAt < new Date()) {
    throw badRequest('This reset link is invalid or has expired. Request a new one.', [{ path: 'token', message: 'Invalid or expired.' }]);
  }
  await prisma.$transaction([
    prisma.customer.update({ where: { id: row.customerId }, data: { passwordHash: await hashPassword(password) } }),
    prisma.passwordResetToken.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
    // Any other outstanding reset links for this account are invalidated by the password change.
    prisma.passwordResetToken.deleteMany({ where: { customerId: row.customerId, id: { not: row.id }, usedAt: null } }),
  ]);
  if (currentSessionToken) {
    await revokeToken(currentSessionToken, 'customer').catch(() => {});
  }
}

/** Development convenience only (the route answers 404 in production). `null` when no account has this
 *  email, otherwise whether a live (unused, unexpired) reset request exists. The raw token was never
 *  stored (only its hash), so this can only confirm that a request exists — it cannot resurrect the
 *  link after the fact. Tests should read the link from the server console output, which prints it in
 *  full when SMTP is not configured. */
export async function hasPendingPasswordReset(email: string): Promise<boolean | null> {
  const customer = email ? await prisma.customer.findUnique({ where: { email } }) : null;
  if (!customer) return null;
  const row = await prisma.passwordResetToken.findFirst({
    where: { customerId: customer.id, usedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
  return !!row;
}
