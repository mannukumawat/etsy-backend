import { prisma } from '../../shared/database/prisma.js';
import { randomHexId } from '../../shared/utils/ids.js';
import type { ExchangeEventRow, ExchangeRequestRow } from './exchange.types.js';

// Prisma-model reads for exchanges. The mappers and routes still consume the
// snake_case row shapes below, so this module maps the Prisma models (camelCase
// fields) onto those shapes at the boundary — the public contract is unchanged.

export interface ExchangeRequestModel {
  id: string; reference: string; orderId: string; orderLineId: string;
  originalVariantId: string; replacementVariantId: string;
  requestedQty: number; approvedQty: number | null; reason: string;
  customerNote: string | null; adminNote: string | null; rejectionReason: string | null;
  status: string; priceDifference: number; exchangeWindowDays: number;
  replacementCarrier: string | null; replacementTracking: string | null;
  requestedAt: Date; decidedAt: Date | null; shippedAt: Date | null;
  deliveredAt: Date | null; closedAt: Date | null;
}

export interface ExchangeEventModel {
  id: string; exchangeId: string; type: string; actor: string;
  actorId: string | null; message: string | null; createdAt: Date;
}

/** Prisma ExchangeRequest -> the snake_case row the mappers and routes consume. */
export function toExchangeRequestRow(r: ExchangeRequestModel): ExchangeRequestRow {
  return {
    id: r.id,
    reference: r.reference,
    order_id: r.orderId,
    order_line_id: r.orderLineId,
    original_variant_id: r.originalVariantId,
    replacement_variant_id: r.replacementVariantId,
    requested_qty: r.requestedQty,
    approved_qty: r.approvedQty,
    reason: r.reason,
    customer_note: r.customerNote,
    admin_note: r.adminNote,
    rejection_reason: r.rejectionReason,
    status: r.status,
    price_difference: r.priceDifference,
    exchange_window_days: r.exchangeWindowDays,
    replacement_carrier: r.replacementCarrier,
    replacement_tracking: r.replacementTracking,
    requested_at: r.requestedAt,
    decided_at: r.decidedAt,
    shipped_at: r.shippedAt,
    delivered_at: r.deliveredAt,
    closed_at: r.closedAt,
  };
}

export function toExchangeEventRow(e: ExchangeEventModel): ExchangeEventRow {
  return {
    id: e.id,
    exchange_id: e.exchangeId,
    type: e.type,
    actor: e.actor,
    actor_id: e.actorId,
    message: e.message,
    created_at: e.createdAt,
  };
}

export async function fetchExchangeWithEvents(exchangeId: string) {
  const [row, events] = await Promise.all([
    prisma.exchangeRequest.findUnique({ where: { id: exchangeId } }),
    prisma.exchangeEvent.findMany({ where: { exchangeId }, orderBy: { createdAt: 'asc' } }),
  ]);
  return { row: row ? toExchangeRequestRow(row) : null, events: events.map(toExchangeEventRow) };
}

export async function addExchangeEvent(exchangeId: string, type: string, actor: string, message: string, actorId?: string) {
  await prisma.exchangeEvent.create({
    data: {
      id: randomHexId(12),
      exchangeId,
      type,
      actor,
      actorId: actorId ?? null,
      message,
    },
  });
}
