import { createHash, randomBytes } from 'node:crypto';

/** SHA-256 of `text` as lowercase hex. */
export const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Password-reset links live for 1 hour — the same TTL for customer and owner resets. */
export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

/**
 * Fresh reset token + its hash. The raw token goes only into the emailed link; only
 * the hash is ever stored or compared. One helper for every reset flow (customer and
 * owner) so the token format can never drift between them.
 */
export function newResetToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('hex');
  return { token, tokenHash: sha256Hex(token) };
}
