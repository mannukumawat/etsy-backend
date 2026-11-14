import { isoDate } from '../../shared/utils/dates.js';
import type { ExchangeEventRow, ExchangeRequestRow } from './exchange.types.js';

export function toPublicExchange(r: ExchangeRequestRow, events: ExchangeEventRow[] = []) {
  return {
    id: r.id,
    reference: r.reference,
    orderId: r.order_id,
    lineId: r.order_line_id,
    originalVariantId: r.original_variant_id,
    replacementVariantId: r.replacement_variant_id,
    requestedQty: r.requested_qty,
    approvedQty: r.approved_qty,
    reason: r.reason,
    customerNote: r.customer_note,
    status: r.status,
    priceDifference: r.price_difference,
    exchangeWindowDays: r.exchange_window_days,
    replacementCarrier: r.replacement_carrier,
    replacementTracking: r.replacement_tracking,
    requestedAt: isoDate(r.requested_at)!,
    decidedAt: isoDate(r.decided_at),
    shippedAt: isoDate(r.shipped_at),
    deliveredAt: isoDate(r.delivered_at),
    closedAt: isoDate(r.closed_at),
    events: events.map(e => ({
      id: e.id, type: e.type, actor: e.actor,
      message: e.message,
      createdAt: isoDate(e.created_at)!,
    })),
  };
}

export function toAdminExchange(r: ExchangeRequestRow, events: ExchangeEventRow[] = []) {
  const base = toPublicExchange(r, events);
  return {
    ...base,
    adminNote: r.admin_note,
    rejectionReason: r.rejection_reason,
  };
}
