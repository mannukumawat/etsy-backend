// Prisma unique-violation classifiers for the order-placement retry loop (M-I6).
// Pure helpers, tested without a database.

export function isOrderNumberClash(e: unknown): boolean {
  const err = e as { code?: string; meta?: { target?: unknown } };
  return err?.code === 'P2002' && String(err.meta?.target ?? '').includes('number');
}

/** The loser's insert violated the idempotencyKey unique constraint — a replay, not an error. */
export function isIdempotencyKeyClash(e: unknown): boolean {
  const err = e as { code?: string; meta?: { target?: unknown } };
  return err?.code === 'P2002' && String(err.meta?.target ?? '').includes('idempotencyKey');
}

/**
 * A second placeOrder tried to fund an order with a Razorpay payment id that already
 * belongs to another order (@@unique([paymentReference])). Never a second paid order:
 * the caller replays the existing order when it matches, or returns 409.
 */
export function isPaymentReferenceClash(e: unknown): boolean {
  const err = e as { code?: string; meta?: { target?: unknown } };
  return err?.code === 'P2002' && String(err.meta?.target ?? '').includes('paymentReference');
}

/**
 * The per-customer coupon limit is a unique constraint (@@unique([couponId,
 * customerKey])) — a second redemption for the same customer is a 409 conflict,
 * never a 500.
 */
export function isCouponRedemptionClash(e: unknown): boolean {
  const err = e as { code?: string; meta?: { target?: unknown } };
  if (err?.code !== 'P2002') return false;
  const target = String(err.meta?.target ?? '');
  return target.includes('couponId') && target.includes('customerKey');
}

export interface ReplayOrderLike {
  customerId: string | null;
  customerEmail: string;
  currency: string;
  total: number;
  /** Stored payment id (null for full-wallet orders). */
  paymentReference: string | null;
  lines: Array<{ variantId: string; quantity: number }>;
}

export interface ReplayRequestLike {
  customerId: string | null;
  email: string;
  currency: string;
  lines: Array<{ variantId: string; quantity: number }>;
  /** Authoritative total, when already computed (in-transaction replay only). */
  total?: number;
  /** Razorpay payment id presented with this request, when any. */
  razorpayPaymentId?: string | null;
}

function linesMatch(a: Array<{ variantId: string; quantity: number }>, b: Array<{ variantId: string; quantity: number }>): boolean {
  if (a.length !== b.length) return false;
  const key = (l: { variantId: string; quantity: number }) => `${l.variantId}:${l.quantity}`;
  const sortedA = [...a].map(key).sort();
  const sortedB = [...b].map(key).sort();
  return sortedA.every((v, i) => v === sortedB[i]);
}

/**
 * Ownership for an idempotent replay (H1c): a signed-in requester must own the order
 * (order.customerId === customerId); a guest requester must match the order's email
 * AND the order must itself be a guest order. Anything else is a 409 — the original
 * order is never handed to someone who did not place it.
 */
export function replayOwnershipMatches(order: Pick<ReplayOrderLike, 'customerId' | 'customerEmail'>, customerId: string | null, email: string): boolean {
  if (customerId) return order.customerId === customerId;
  return order.customerId === null && order.customerEmail === email.trim().toLowerCase();
}

/**
 * Payload check for an idempotent replay (H1c): same currency, same lines
 * (variantId + quantity, order-insensitive) and — once the authoritative total is
 * known — the same total. The payment id, when presented, must also be the one the
 * original order was paid with. Any mismatch is a 409, never the original order.
 * The pre-compute replay cannot check the total yet (it is only known after pricing),
 * so the in-transaction replay re-checks with the total included.
 */
export function replayPayloadMatches(order: ReplayOrderLike, req: ReplayRequestLike): boolean {
  if (order.currency.toUpperCase() !== req.currency.toUpperCase()) return false;
  if (!linesMatch(order.lines, req.lines)) return false;
  if (req.total !== undefined && order.total !== req.total) return false;
  if (req.razorpayPaymentId) {
    if (order.paymentReference !== req.razorpayPaymentId) return false;
  }
  return true;
}
