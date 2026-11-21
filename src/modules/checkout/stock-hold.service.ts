import { prisma } from '../../shared/database/prisma.js';

// Stock holds (H5): a short-lived reservation created when a Razorpay order is
// created at checkout, so the last unit cannot be sold twice while the customer is
// in the Razorpay modal. Holds are consumed (deleted) when placeOrder succeeds;
// expired rows are swept on every create-order call and never block stock past
// `expiresAt`. Stock-availability checks subtract unexpired holds (see
// checkout.service.ts resolveLines). If a hold expired between create-order and
// placeOrder, placeOrder still succeeds via its conditional stock decrement — the
// hold is a best-effort reservation, never a second stock lock.

/**
 * How long a hold reserves stock. Single place this value lives (standing rule:
 * no hardcoded TTLs scattered through the code). 15 minutes covers the Razorpay
 * modal; a longer TTL would hold stock hostage after an abandoned checkout.
 */
export const HOLD_TTL_MS = 15 * 60 * 1000;

/** Expiry for a hold created now. Pure, so hold-expiry math is unit-testable. */
export function holdExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + HOLD_TTL_MS);
}

/** True when a hold no longer reserves stock at `now`. Pure. */
export function isHoldExpired(expiresAt: Date, now: Date = new Date()): boolean {
  return expiresAt.getTime() <= now.getTime();
}

/** Stock left after subtracting unexpired holds. Pure; never goes negative. */
export function availableAfterHolds(stock: number, reserved: number): number {
  return Math.max(0, stock - Math.max(0, reserved));
}

type StockHoldDb = {
  stockHold: {
    groupBy(args: unknown): Promise<Array<{ variantId: string; _sum: { quantity: number | null } }>>;
    deleteMany(args: unknown): Promise<{ count: number }>;
    createMany(args: unknown): Promise<{ count: number }>;
  };
};

const defaultDb: StockHoldDb = prisma as unknown as StockHoldDb;

/**
 * Unexpired reserved quantities per variant, in ONE indexed query
 * (@@index([variantId, expiresAt]) — never a full-table scan). Variants with no
 * live hold are absent from the map (callers treat absence as 0).
 */
export async function reservedQuantities(variantIds: string[], db: StockHoldDb = defaultDb): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (!variantIds.length) return result;
  const rows = await db.stockHold.groupBy({
    by: ['variantId'],
    where: { variantId: { in: variantIds }, expiresAt: { gt: new Date() } },
    _sum: { quantity: true },
  });
  for (const row of rows) {
    const qty = row._sum?.quantity ?? 0;
    if (qty > 0) result.set(row.variantId, qty);
  }
  return result;
}

/** Deletes every expired hold. Runs first inside createHolds (below). */
export async function sweepExpiredHolds(db: StockHoldDb = defaultDb): Promise<number> {
  const deleted = await db.stockHold.deleteMany({ where: { expiresAt: { lte: new Date() } } });
  return deleted.count;
}

export interface HoldLine {
  variantId: string;
  quantity: number;
}

/**
 * Creates one hold per variant for a Razorpay order (duplicate lines for the same
 * variant are aggregated first — the model is @@unique([razorpayOrderId, variantId])).
 * Sweeps expired holds first so stale rows never accumulate. `skipDuplicates`
 * makes a retried create-order for the same Razorpay order idempotent.
 */
export async function createHolds(
  args: { razorpayOrderId: string; customerKey: string | null; lines: HoldLine[]; now?: Date },
  db: StockHoldDb = defaultDb,
): Promise<Date> {
  const now = args.now ?? new Date();
  await sweepExpiredHolds(db);
  const perVariant = new Map<string, number>();
  for (const line of args.lines) {
    if (line.quantity <= 0) continue;
    perVariant.set(line.variantId, (perVariant.get(line.variantId) ?? 0) + line.quantity);
  }
  if (!perVariant.size) return holdExpiry(now);
  const expiresAt = holdExpiry(now);
  await db.stockHold.createMany({
    data: [...perVariant.entries()].map(([variantId, quantity]) => ({
      variantId,
      quantity,
      razorpayOrderId: args.razorpayOrderId,
      customerKey: args.customerKey,
      expiresAt,
    })),
    skipDuplicates: true,
  });
  return expiresAt;
}

/**
 * Consumes the holds for a Razorpay order once placeOrder succeeds. Runs inside
 * the order transaction, so a hold is never consumed without its order.
 */
export async function consumeHolds(tx: StockHoldDb, razorpayOrderId: string): Promise<void> {
  await tx.stockHold.deleteMany({ where: { razorpayOrderId } });
}
