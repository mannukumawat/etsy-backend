import { prisma } from '../../shared/database/prisma.js';
import type { RefundRow, ReturnEventRow, ReturnRequestRow } from './return.types.js';

/** A return with its event timeline and refund (if any). `row` is null when the id is unknown. */
export async function fetchReturnWithDetails(returnId: string) {
  const [rows, events, refunds] = await Promise.all([
    prisma.$queryRawUnsafe<ReturnRequestRow[]>(`SELECT * FROM return_requests WHERE id = ?`, returnId),
    prisma.$queryRawUnsafe<ReturnEventRow[]>(`SELECT * FROM return_events WHERE return_id = ? ORDER BY created_at ASC`, returnId),
    prisma.$queryRawUnsafe<RefundRow[]>(`SELECT * FROM refunds WHERE return_id = ?`, returnId),
  ]);
  return { row: rows[0] ?? null, events, refund: refunds[0] ?? null };
}
