import { prisma } from '../../shared/database/prisma.js';
import type { RefundRow, ReturnEventRow, ReturnRequestRow } from './return.types.js';

// Prisma-model reads for returns / refunds. The mappers and routes still consume the
// snake_case row shapes below, so this module maps the Prisma models (camelCase
// fields) onto those shapes at the boundary — the public contract is unchanged.

// Structural shapes of the Prisma models (kept local so this file does not depend on
// the generated client types at edit time).

export interface ReturnRequestModel {
  id: string; reference: string; orderId: string; orderLineId: string; variantId: string;
  requestedQty: number; approvedQty: number | null; receivedQty: number | null;
  acceptedQty: number | null; restockQty: number | null; reason: string;
  customerNote: string | null; adminNote: string | null; rejectionReason: string | null;
  photos: string | null; status: string; shippingMethod: string | null;
  customerCarrier: string | null; customerTracking: string | null; pickupAddress: string | null;
  returnCarrier: string | null; returnTracking: string | null; refundableAmount: number;
  shippingFee: number; refundAmount: number | null; returnWindowDays: number;
  refundAccountId: string | null; refundMethodOverride: string | null;
  requestedAt: Date; decidedAt: Date | null; receivedAt: Date | null;
  inspectedAt: Date | null; refundedAt: Date | null;
}

export interface ReturnEventModel {
  id: string; returnId: string; type: string; actor: string; actorId: string | null;
  message: string | null; data: string | null; createdAt: Date;
}

export interface RefundModel {
  id: string; orderId: string; returnId: string | null; amount: number; reason: string;
  method: string; status: string; reference: string | null; completedAt: Date | null;
  failedAt: Date | null; recordedBy: string | null; note: string | null;
  createdAt: Date; updatedAt: Date;
}

/** Prisma ReturnRequest -> the snake_case row the mappers and routes consume. */
export function toReturnRequestRow(r: ReturnRequestModel): ReturnRequestRow {
  return {
    id: r.id,
    reference: r.reference,
    order_id: r.orderId,
    order_line_id: r.orderLineId,
    variant_id: r.variantId,
    requested_qty: r.requestedQty,
    approved_qty: r.approvedQty,
    received_qty: r.receivedQty,
    accepted_qty: r.acceptedQty,
    restock_qty: r.restockQty,
    reason: r.reason,
    customer_note: r.customerNote,
    admin_note: r.adminNote,
    rejection_reason: r.rejectionReason,
    photos: r.photos,
    status: r.status,
    shipping_method: r.shippingMethod,
    customer_carrier: r.customerCarrier,
    customer_tracking: r.customerTracking,
    pickup_address: r.pickupAddress,
    return_carrier: r.returnCarrier,
    return_tracking: r.returnTracking,
    refundable_amount: r.refundableAmount,
    shipping_fee: r.shippingFee,
    refund_amount: r.refundAmount,
    return_window_days: r.returnWindowDays,
    requested_at: r.requestedAt,
    decided_at: r.decidedAt,
    received_at: r.receivedAt,
    inspected_at: r.inspectedAt,
    refunded_at: r.refundedAt,
    // The row type does not declare these two columns yet, but the admin mapper
    // reads them (refund_account_id / refund_method_override) — keep them on the
    // row so the mapper keeps working until the type gains the fields.
    refund_account_id: r.refundAccountId,
    refund_method_override: r.refundMethodOverride,
  } as ReturnRequestRow;
}

export function toReturnEventRow(e: ReturnEventModel): ReturnEventRow {
  return {
    id: e.id,
    return_id: e.returnId,
    type: e.type,
    actor: e.actor,
    actor_id: e.actorId,
    message: e.message,
    data: e.data,
    created_at: e.createdAt,
  };
}

export function toRefundRow(r: RefundModel): RefundRow {
  return {
    id: r.id,
    order_id: r.orderId,
    return_id: r.returnId,
    amount: r.amount,
    reason: r.reason,
    method: r.method,
    status: r.status,
    reference: r.reference,
    completed_at: r.completedAt,
    failed_at: r.failedAt,
    recorded_by: r.recordedBy,
    note: r.note,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
}

/** A return with its event timeline and refund (if any). `row` is null when the id is unknown. */
export async function fetchReturnWithDetails(returnId: string) {
  const [row, events, refund] = await Promise.all([
    prisma.returnRequest.findUnique({ where: { id: returnId } }),
    prisma.returnEvent.findMany({ where: { returnId }, orderBy: { createdAt: 'asc' } }),
    prisma.refund.findFirst({ where: { returnId } }),
  ]);
  return {
    row: row ? toReturnRequestRow(row) : null,
    events: events.map(toReturnEventRow),
    refund: refund ? toRefundRow(refund) : null,
  };
}
