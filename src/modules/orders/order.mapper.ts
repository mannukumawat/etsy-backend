import type { Prisma } from '@prisma/client';
import { L, Lopt } from '../../shared/utils/localized.js';

export const ORDER_INCLUDE = {
  lines: true,
  events: { orderBy: { at: 'asc' as const } },
  notes: { orderBy: { at: 'asc' as const } },
} satisfies Prisma.OrderInclude;

export type OrderRow = Prisma.OrderGetPayload<{ include: typeof ORDER_INCLUDE }>;

/** The stored snapshot is always the full `{base, rates, asOf}` map (shared/utils/currency.ts buildRateSnapshot);
 *  admin's RateSnapshot type is the single-rate shape, so this projects out just the order's own
 *  currency. The storefront keeps the full map (toStorefrontRateSnapshot below). */
function toAdminRateSnapshot(rateSnapshotJson: string, orderCurrency: string) {
  const stored = JSON.parse(rateSnapshotJson) as { base: 'USD'; rates: Record<string, number>; asOf: string };
  return { base: stored.base, currency: orderCurrency, rate: stored.rates[orderCurrency] ?? 1, capturedAt: stored.asOf };
}

function toStorefrontRateSnapshot(rateSnapshotJson: string) {
  const stored = JSON.parse(rateSnapshotJson) as { base: 'USD'; rates: Record<string, number>; asOf: string };
  return { base: stored.base, rates: stored.rates, asOf: stored.asOf, illustrative: true as const };
}

export function toAdminOrder(o: OrderRow, extras?: LineExtras) {
  return {
    id: o.id,
    number: o.number,
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
    customer: { kind: o.customerKind as 'account' | 'guest', customerId: o.customerId, name: o.customerName, email: o.customerEmail, phone: o.customerPhone },
    shippingAddress: JSON.parse(o.shippingAddressJson),
    currency: o.currency,
    rateSnapshot: toAdminRateSnapshot(o.rateSnapshotJson, o.currency),
    lines: o.lines.map((l) => ({
      id: l.id,
      productId: l.productId,
      variantId: l.variantId,
      sku: l.sku,
      name: L(l.nameEn, l.nameHi),
      variantLabel: l.variantLabelEn || null,
      imageUrl: l.imageUrl || null,
      unitPrice: l.unitPrice,
      quantity: l.quantity,
      lineTotal: l.lineTotal,
      cancelledQty: extras?.get(l.id)?.cancelledQty ?? 0,
      returnedQty: extras?.get(l.id)?.returnedQty ?? 0,
    })),
    subtotal: o.subtotal,
    discount: o.discount,
    couponCode: o.couponCode,
    shipping: o.shipping,
    tax: o.tax,
    taxRate: o.taxRate,
    taxInclusive: o.taxInclusive,
    total: o.total,
    refundedTotal: o.refundedTotal,
    shippingMethod: { id: o.shippingMethodId as 'standard' | 'express', label: o.shippingMethodLabel, minDays: o.shippingMinDays, maxDays: o.shippingMaxDays },
    payment: { status: o.paymentStatus as 'unpaid' | 'paid' | 'failed' | 'partially_refunded' | 'refunded', method: o.paymentMethod as 'cod' | 'card' | 'upi' | 'wallet', reference: o.paymentReference },
    fulfilment: {
      status: o.fulfilmentStatus as 'unfulfilled' | 'processing' | 'shipped' | 'delivered' | 'cancelled',
      carrier: o.carrier,
      trackingNumber: o.trackingNumber,
      trackingUrl: o.trackingUrl,
      restocked: o.restocked,
    },
    events: o.events.map((e) => ({ id: e.id, at: e.at.toISOString(), type: e.type, message: e.message, actor: e.actor as 'system' | 'customer' | 'admin' })),
    notes: o.notes.map((n) => ({ id: n.id, at: n.at.toISOString(), author: n.author, body: n.body })),
  };
}

/** 'unfulfilled' has no storefront-facing equivalent; a brand-new order simply reads as "placed". */
const STOREFRONT_STATUS: Record<string, 'placed' | 'processing' | 'shipped' | 'delivered' | 'cancelled'> = {
  unfulfilled: 'placed',
  processing: 'processing',
  shipped: 'shipped',
  delivered: 'delivered',
  cancelled: 'cancelled',
};

/** Per order-line cancel/return counters (columns outside the Prisma model; see order-line-extras.service.ts). */
export type LineExtras = Map<string, { cancelledQty: number; returnedQty: number }>;

export function toStorefrontOrder(o: OrderRow, extras?: LineExtras) {
  const timeline = o.events
    .filter((e) => e.type === 'created' || e.type === 'fulfilment' || (e.type === 'cancelled' && !e.message.startsWith('Item cancelled')))
    .map((e) => ({ status: e.type === 'created' ? 'placed' : (STOREFRONT_STATUS[e.message.split(':')[0]] ?? STOREFRONT_STATUS[o.fulfilmentStatus]), date: e.at.toISOString() }));
  return {
    id: o.id,
    number: o.number,
    createdAt: o.createdAt.toISOString(),
    userId: o.customerId ?? undefined,
    email: o.customerEmail,
    phone: o.customerPhone,
    lines: o.lines.map((l) => ({
      id: l.id,
      productId: l.productId,
      variantId: l.variantId,
      slug: l.slug,
      name: Lopt(l.nameEn, l.nameHi),
      variantLabel: l.variantLabelEn ? Lopt(l.variantLabelEn, l.variantLabelHi) : null,
      image: { src: l.imageUrl ? l.imageUrl : '', alt: Lopt(l.nameEn, l.nameHi) },
      unitPrice: l.unitPrice,
      quantity: l.quantity,
      lineTotal: l.lineTotal,
      cancelledQty: extras?.get(l.id)?.cancelledQty ?? 0,
      returnedQty: extras?.get(l.id)?.returnedQty ?? 0,
    })),
    currency: o.currency,
    rateSnapshot: toStorefrontRateSnapshot(o.rateSnapshotJson),
    subtotal: o.subtotal,
    discount: o.discount,
    ...(o.couponCode ? { couponCode: o.couponCode } : {}),
    shipping: o.shipping,
    tax: o.tax,
    // Stored as a percentage (12 = 12%); the storefront formats a fraction (0.12).
    taxRate: o.taxRate / 100,
    total: o.total,
    shippingMethod: { id: o.shippingMethodId as 'standard' | 'express', minDays: o.shippingMinDays, maxDays: o.shippingMaxDays },
    address: JSON.parse(o.shippingAddressJson),
    paymentMethod: o.paymentMethod as 'cod' | 'card' | 'upi' | 'wallet',
    status: STOREFRONT_STATUS[o.fulfilmentStatus] ?? 'placed',
    timeline: [{ status: 'placed' as const, date: o.createdAt.toISOString() }, ...timeline.filter((t) => t.status !== 'placed')],
    ...(o.trackingNumber ? { tracking: { carrier: o.carrier ?? '', number: o.trackingNumber } } : {}),
  };
}

/**
 * Public order-number + email "track my order" lookup — reachable by anyone who can guess/know the
 * order number and the email it was placed under, which is a much weaker proof of ownership than the
 * unguessable id (+ guest token, for a guest order) the full order view requires. Keeps shipment
 * status, timeline, line items and totals (the actual "where is my package" content) but drops the
 * full shipping address, phone number and email — none of which this view needs to show.
 */
export function toStorefrontOrderTrack(o: OrderRow) {
  const full = toStorefrontOrder(o);
  return {
    ...full,
    email: '',
    phone: '',
    address: { ...full.address, fullName: '', phoneCountry: '', phone: '', line1: '', line2: undefined, city: undefined, region: undefined, postalCode: undefined },
  };
}
