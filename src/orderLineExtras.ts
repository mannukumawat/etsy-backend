import { prisma } from './db.js';
import type { LineExtras } from './mappers.js';

/**
 * `cancelled_qty` / `returned_qty` live on order_lines but outside the Prisma model (added by migrate-returns.ts),
 * so they are read with a small raw query and attached to the storefront order lines.
 */
export async function loadLineExtras(orderIds: string[]): Promise<LineExtras> {
  const extras: LineExtras = new Map();
  if (!orderIds.length) return extras;
  const marks = orderIds.map(() => '?').join(',');
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ id: string; cancelled_qty: number; returned_qty: number }>>(
      `SELECT id, cancelled_qty, returned_qty FROM order_lines WHERE orderId IN (${marks})`,
      ...orderIds,
    );
    for (const r of rows) extras.set(r.id, { cancelledQty: Number(r.cancelled_qty) || 0, returnedQty: Number(r.returned_qty) || 0 });
  } catch {
    // Columns missing (migration not run yet): fall back to zeros rather than breaking order pages.
  }
  return extras;
}
