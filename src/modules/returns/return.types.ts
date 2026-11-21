// Row shapes for the return/refund tables, which are real Prisma models
// (ReturnRequest / ReturnEvent / Refund) since migration 20261121010000.
// The repository maps Prisma models to these snake_case row shapes.

export interface ReturnRequestRow {
  id: string; reference: string; order_id: string; order_line_id: string; variant_id: string;
  requested_qty: number; approved_qty: number | null; received_qty: number | null;
  accepted_qty: number | null; restock_qty: number | null;
  reason: string; customer_note: string | null; admin_note: string | null;
  rejection_reason: string | null; photos: string | null; status: string;
  shipping_method: string | null; customer_carrier: string | null; customer_tracking: string | null;
  pickup_address: string | null; return_carrier: string | null; return_tracking: string | null;
  refundable_amount: number; shipping_fee: number; refund_amount: number | null;
  return_window_days: number;
  refund_account_id: string | null; refund_method_override: string | null;
  requested_at: Date; decided_at: Date | null; received_at: Date | null;
  inspected_at: Date | null; refunded_at: Date | null;
}

export interface ReturnEventRow {
  id: string; return_id: string; type: string; actor: string; actor_id: string | null;
  message: string | null; data: string | null; created_at: Date;
}

export interface RefundRow {
  id: string; order_id: string; return_id: string | null; amount: number;
  reason: string; method: string; status: string; reference: string | null;
  completed_at: Date | null; failed_at: Date | null; recorded_by: string | null;
  note: string | null; created_at: Date; updated_at: Date;
}

/** A return row as selected by the admin list query: the return plus joined order / order-line columns. */
export type ReturnListRow = ReturnRequestRow & {
  order_number: string; customer_email: string; customer_name: string;
  name_en: string; variant_label_en: string; unit_price: number;
};

/** The order-line columns shown next to a return in the admin detail view. */
export interface ReturnLineSummary {
  name_en: string; variant_label_en: string; unit_price: number;
}

/** The signed-in owner performing an admin action: `id` is recorded on return events, `email` on refunds and stock adjustments. */
export interface OwnerActor {
  id: string;
  email: string;
}
