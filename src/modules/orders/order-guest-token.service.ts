import { timingSafeEqual } from 'node:crypto';
import { sha256Hex } from '../../shared/utils/crypto.js';
import { randomHexId } from '../../shared/utils/ids.js';

// A guest order has no account session to prove ownership, so checkout mints a one-time, high-entropy
// access token for it (returned once, in the checkout response). Only the hash is ever stored; the raw
// value exists only in that request/response. The order lookup (order-tracking.service.ts) accepts it
// as the X-Order-Token header.

const GUEST_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — long enough to revisit a confirmation page

export const newGuestToken = () => randomHexId(32);
export const hashGuestToken = (raw: string) => sha256Hex(raw);
export const guestTokenExpiry = () => new Date(Date.now() + GUEST_TOKEN_TTL_MS);

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** True when `suppliedToken` matches the order's stored, still-unexpired guest token hash. */
export function guestTokenGrantsAccess(
  order: { guestTokenHash: string | null; guestTokenExpiresAt: Date | null },
  suppliedToken: string | undefined,
): boolean {
  const stillValid = order.guestTokenExpiresAt ? order.guestTokenExpiresAt.getTime() > Date.now() : false;
  return !!suppliedToken && !!order.guestTokenHash && stillValid && safeEqual(hashGuestToken(suppliedToken), order.guestTokenHash);
}
