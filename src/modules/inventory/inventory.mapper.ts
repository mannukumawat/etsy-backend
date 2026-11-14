import { mediaUrl } from '../../shared/config/env.js';
import { L } from '../../shared/utils/localized.js';

export function toInventoryRow(v: {
  id: string; sku: string; stock: number;
  product: { id: string; nameEn: string; nameHi: string; categoryId: string; status: string; images: Array<{ mediaId: string }> };
  options: string;
}, optionLabel: string | null, lastAdjustedAt: Date | null) {
  return {
    productId: v.product.id,
    variantId: v.id,
    sku: v.sku,
    productName: L(v.product.nameEn, v.product.nameHi),
    variantLabel: optionLabel,
    imageUrl: v.product.images[0] ? mediaUrl(v.product.images[0].mediaId) : null,
    categoryId: v.product.categoryId,
    productStatus: v.product.status as 'draft' | 'active' | 'archived',
    stock: v.stock,
    lastAdjustedAt: lastAdjustedAt ? lastAdjustedAt.toISOString() : null,
  };
}

export function toStockAdjustment(a: {
  id: string; productId: string; variantId: string; sku: string; productNameEn: string; productNameHi: string;
  variantLabel: string; before: number; after: number; delta: number; reason: string; note: string; actor: string; createdAt: Date;
}) {
  return {
    id: a.id,
    productId: a.productId,
    variantId: a.variantId,
    sku: a.sku,
    // admin/src/types StockAdjustment.productName is a plain string (unlike InventoryRow.productName,
    // which is Localized) — matches the mock's `product.name.en`.
    productName: a.productNameEn,
    variantLabel: a.variantLabel || null,
    before: a.before,
    after: a.after,
    delta: a.delta,
    reason: a.reason as 'restock' | 'correction' | 'damaged' | 'returned' | 'order_cancelled' | 'other',
    note: a.note,
    createdAt: a.createdAt.toISOString(),
    actor: a.actor,
  };
}
