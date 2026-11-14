import type { OrderRow } from '../orders/order.mapper.js';

/** Who is buying. Drives the per-customer coupon limit key: `acct:<customerId>` for a signed-in account,
 *  otherwise `guest:<email>`. */
export interface Buyer {
  customerId: string | null;
  email: string;
}

export interface ResolvedLine {
  productId: string;
  variantId: string;
  categoryId: string;
  quantity: number;
  unitPriceConverted: number;
  lineTotalConverted: number;
  sku: string;
  nameEn: string;
  nameHi: string;
  slug: string;
  variantLabelEn: string;
  variantLabelHi: string;
  imageUrl: string;
  availableStock: number;
}

export interface StockIssue {
  productId: string;
  variantId: string;
  requested: number;
  available: number;
}

/** `replayed` is an idempotent retry of an already-placed order (answered 200); otherwise the order was
 *  just created (201) and, for guests, `guestToken` is the one-time raw access token. */
export type PlaceOrderResult =
  | { replayed: true; order: OrderRow }
  | { replayed: false; order: OrderRow; guestToken: string | null };
