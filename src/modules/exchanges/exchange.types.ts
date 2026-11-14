export interface ExchangeRequestRow {
  id: string; reference: string; order_id: string; order_line_id: string;
  original_variant_id: string; replacement_variant_id: string;
  requested_qty: number; approved_qty: number | null;
  reason: string; customer_note: string | null; admin_note: string | null;
  rejection_reason: string | null; status: string;
  price_difference: number; exchange_window_days: number;
  replacement_carrier: string | null; replacement_tracking: string | null;
  requested_at: Date; decided_at: Date | null; shipped_at: Date | null;
  delivered_at: Date | null; closed_at: Date | null;
}

export interface ExchangeEventRow {
  id: string; exchange_id: string; type: string; actor: string;
  actor_id: string | null; message: string | null; created_at: Date;
}

/** The signed-in owner performing an admin action: `id` is recorded on exchange events, `email` on stock adjustments. */
export interface OwnerActor {
  id: string;
  email: string;
}
