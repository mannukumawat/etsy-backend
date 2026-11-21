// One builder for InventoryAdjustment rows (H2): every stock move outside a manual
// adjustment — a sale, a new variant's initial stock, an exchange shipment — records
// the same denormalised snapshot (before/after/delta + product/variant identity), so
// the history log and "Last adjusted" can never silently miss a mover again.
// `delta` is always derived from before/after, never passed in, so a row can never
// claim a different change than the stock actually made (H4).
export interface InventoryAdjustmentData {
  productId: string;
  variantId: string;
  sku: string;
  productNameEn: string;
  productNameHi: string;
  variantLabel: string;
  before: number;
  after: number;
  reason: string;
  note: string;
  actor: string;
}

export function adjustmentData(d: InventoryAdjustmentData) {
  return {
    productId: d.productId,
    variantId: d.variantId,
    sku: d.sku,
    productNameEn: d.productNameEn,
    productNameHi: d.productNameHi,
    variantLabel: d.variantLabel,
    before: d.before,
    after: d.after,
    delta: d.after - d.before,
    reason: d.reason,
    note: d.note,
    actor: d.actor,
  };
}
