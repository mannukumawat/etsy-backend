import type { RefundRow, ReturnEventRow, ReturnLineSummary, ReturnListRow, ReturnRequestRow } from './return.types.js';

export function toPublicReturn(r: ReturnRequestRow, events: ReturnEventRow[] = [], refund: RefundRow | null = null) {
  return {
    id: r.id,
    reference: r.reference,
    orderId: r.order_id,
    lineId: r.order_line_id,
    variantId: r.variant_id,
    requestedQty: r.requested_qty,
    approvedQty: r.approved_qty,
    receivedQty: r.received_qty,
    acceptedQty: r.accepted_qty,
    reason: r.reason,
    customerNote: r.customer_note,
    photos: r.photos ? JSON.parse(r.photos) as string[] : [],
    status: r.status,
    shippingMethod: r.shipping_method,
    customerCarrier: r.customer_carrier,
    customerTracking: r.customer_tracking,
    returnCarrier: r.return_carrier,
    returnTracking: r.return_tracking,
    refundableAmount: r.refundable_amount,
    shippingFee: r.shipping_fee,
    refundAmount: r.refund_amount,
    returnWindowDays: r.return_window_days,
    requestedAt: r.requested_at instanceof Date ? r.requested_at.toISOString() : String(r.requested_at),
    decidedAt: r.decided_at ? (r.decided_at instanceof Date ? r.decided_at.toISOString() : String(r.decided_at)) : null,
    receivedAt: r.received_at ? (r.received_at instanceof Date ? r.received_at.toISOString() : String(r.received_at)) : null,
    inspectedAt: r.inspected_at ? (r.inspected_at instanceof Date ? r.inspected_at.toISOString() : String(r.inspected_at)) : null,
    refundedAt: r.refunded_at ? (r.refunded_at instanceof Date ? r.refunded_at.toISOString() : String(r.refunded_at)) : null,
    events: events.map(e => ({
      id: e.id, type: e.type, actor: e.actor,
      message: e.message,
      createdAt: e.created_at instanceof Date ? e.created_at.toISOString() : String(e.created_at),
    })),
    refund: refund ? {
      id: refund.id, amount: refund.amount, method: refund.method,
      status: refund.status, reference: refund.reference,
      completedAt: refund.completed_at ? (refund.completed_at instanceof Date ? refund.completed_at.toISOString() : String(refund.completed_at)) : null,
    } : null,
  };
}

export function toAdminReturn(r: ReturnRequestRow, events: ReturnEventRow[] = [], refund: RefundRow | null = null) {
  const base = toPublicReturn(r, events, refund);
  return {
    ...base,
    adminNote: r.admin_note,
    rejectionReason: r.rejection_reason,
    restockQty: r.restock_qty,
    pickupAddress: r.pickup_address,
    refundAccountId: (r as any).refund_account_id ?? null,
    refundMethodOverride: (r as any).refund_method_override ?? null,
    refund: refund ? {
      id: refund.id, amount: refund.amount, method: refund.method,
      status: refund.status, reference: refund.reference,
      note: refund.note, recordedBy: refund.recorded_by,
      completedAt: refund.completed_at ? (refund.completed_at instanceof Date ? refund.completed_at.toISOString() : String(refund.completed_at)) : null,
      failedAt: refund.failed_at ? (refund.failed_at instanceof Date ? refund.failed_at.toISOString() : String(refund.failed_at)) : null,
      createdAt: refund.created_at instanceof Date ? refund.created_at.toISOString() : String(refund.created_at),
    } : null,
  };
}

/** One row of the admin returns list: the return plus the order / line columns the table shows. */
export function toAdminReturnListItem(r: ReturnListRow) {
  return {
    ...toAdminReturn(r),
    orderNumber: r.order_number,
    customerEmail: r.customer_email,
    customerName: r.customer_name,
    itemName: r.name_en,
    variantLabel: r.variant_label_en,
    unitPrice: r.unit_price,
  };
}

/** The admin detail view: the return enriched with its order and order-line info. */
export function toAdminReturnDetail(
  row: ReturnRequestRow,
  events: ReturnEventRow[],
  refund: RefundRow | null,
  order: { number: string; customerEmail: string; customerName: string; currency: string } | null,
  line: ReturnLineSummary | undefined,
) {
  return {
    ...toAdminReturn(row, events, refund),
    orderNumber: order?.number,
    customerEmail: order?.customerEmail,
    customerName: order?.customerName,
    currency: order?.currency,
    itemName: line?.name_en,
    variantLabel: line?.variant_label_en,
    unitPrice: line?.unit_price,
  };
}
