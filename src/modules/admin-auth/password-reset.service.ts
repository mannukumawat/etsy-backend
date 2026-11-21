import bcrypt from 'bcryptjs';
import { env } from '../../shared/config/env.js';
import { prisma } from '../../shared/database/prisma.js';
import { badRequest } from '../../shared/errors/http-error.js';
import { sendMail, type SendMailResult } from '../../shared/mail/mailer.js';
import { RESET_TOKEN_TTL_MS, newResetToken, sha256Hex } from '../../shared/utils/crypto.js';
import { revokeToken } from '../../shared/auth/revocation.js';
import { randomHexId } from '../../shared/utils/ids.js';

// Owner password reset (C5). The table lives outside the Prisma model — see
// prisma/migrations/20261120230000_add_owner_password_reset_tokens — so access is
// raw SQL, like the returns/refunds tables. Token generation, hashing and TTL are
// shared with the customer reset flow (shared/utils/crypto.ts) — one implementation.
//
// Security shape: the raw token (32 random bytes) exists only in the emailed link.
// Only its sha256 hash is stored, it expires after 1 hour, it is single-use, and
// requesting a reset for an unknown email answers exactly like a real one (no
// account enumeration). The reset email goes through the shared mailer: without
// SMTP configured nothing is actually delivered and the caller is told so via
// `delivered: false` (see shared/mail/mailer.ts).

export interface ResetRequestResult extends SendMailResult {
  ok: true;
}

interface ResetTokenRow {
  id: string;
  owner_id: string;
  token_hash: string;
  expires_at: Date;
  used_at: Date | null;
}

/**
 * Starts a password reset. Always answers `{ ok: true, delivered }` — whether or
 * not the email belongs to an owner — so the endpoint never reveals if an account
 * exists. When SMTP is not configured the link is logged by the mailer and (outside
 * production) returned as `devPreview`; the admin UI must surface `delivered: false`
 * honestly instead of claiming an email was sent.
 */
export async function requestPasswordReset(email: string): Promise<ResetRequestResult> {
  const normalizedEmail = email.trim().toLowerCase();
  const owner = await prisma.owner.findUnique({ where: { email: normalizedEmail } });
  if (!owner) return { ok: true, delivered: false };

  const { token, tokenHash } = newResetToken();
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
  await prisma.$executeRawUnsafe(
    `INSERT INTO owner_password_reset_tokens (id, owner_id, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, NOW(3))`,
    randomHexId(12),
    owner.id,
    tokenHash,
    expiresAt,
  );

  const resetLink = `${env.ADMIN_APP_URL}/reset-password?token=${token}`;
  const result = await sendMail(
    owner.email,
    'Reset your Your Store admin password',
    [
      'A password reset was requested for your Your Store admin account.',
      '',
      `Reset your password (link expires in 1 hour): ${resetLink}`,
      '',
      'If you did not request this, ignore this email — your password stays unchanged.',
    ].join('\n'),
  );
  return { ok: true, ...result };
}

/** Consumes a reset token: validates it, sets the new password, invalidates the token.
 *  When the owner resets while still signed in, the current session token is revoked
 *  too (best-effort — a reset from a logged-out browser simply has no token to revoke). */
export async function resetPassword(token: string, newPassword: string, currentSessionToken?: string): Promise<{ ok: true }> {
  const tokenHash = sha256Hex(token);
  const rows = await prisma.$queryRawUnsafe<ResetTokenRow[]>(
    `SELECT * FROM owner_password_reset_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW(3)`,
    tokenHash,
  );
  const row = rows[0];
  if (!row) {
    throw badRequest('This reset link is invalid or has expired. Request a new reset link.');
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await prisma.owner.update({ where: { id: row.owner_id }, data: { passwordHash } });
  // Single-use: mark this token used and invalidate any other outstanding tokens.
  await prisma.$executeRawUnsafe(
    `UPDATE owner_password_reset_tokens SET used_at = NOW(3) WHERE owner_id = ? AND used_at IS NULL`,
    row.owner_id,
  );
  // Revoke the current owner session (if any) so a compromised session cannot survive
  // the password change. Best-effort: revocation must never fail the reset itself.
  if (currentSessionToken) await revokeToken(currentSessionToken, 'owner').catch(() => {});
  return { ok: true };
}
