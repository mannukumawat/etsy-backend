import type { Prisma } from '@prisma/client';
import { mediaUrl } from './env.js';
import { parseStringArray, parseStringMap } from './json.js';

// Two shapes come out of one row set:
//   - toAdminProduct: mirrors admin/src/types Product (media *ids*, EN/HI pairs, status, SEO).
//   - toStorefrontProduct: mirrors frontend/src/types Product (resolved image *URLs*, derived price).
// Keeping both here means the apps' existing components and services need no reshaping.

export const PRODUCT_INCLUDE = {
  images: { orderBy: { position: 'asc' } },
  options: { orderBy: { position: 'asc' }, include: { values: { orderBy: { position: 'asc' } } } },
  variants: { orderBy: { position: 'asc' } },
  specs: { orderBy: { position: 'asc' } },
  category: true,
} satisfies Prisma.ProductInclude;

export type ProductRow = Prisma.ProductGetPayload<{ include: typeof PRODUCT_INCLUDE }>;
export type CategoryRow = Prisma.CategoryGetPayload<object>;

/** Store content is English-only. The legacy `…Hi` columns are never read into API responses. */
export const L = (en: string, _hi?: string) => ({ en });
/** Storefront `Localized` omits empty translations so its English fallback kicks in. */
const Lopt = (en: string, _hi?: string) => ({ en });

/** Variant option maps and image id lists are stored as JSON text (see src/json.ts). */
const variantOptions = parseStringMap;

// ---------------------------------------------------------------------------------------------
// Admin shape
// ---------------------------------------------------------------------------------------------

export function toAdminProduct(p: ProductRow) {
  return {
    id: p.id,
    slug: p.slug,
    status: p.status as 'draft' | 'active' | 'archived',
    name: L(p.nameEn, p.nameHi),
    shortDescription: L(p.shortDescriptionEn, p.shortDescriptionHi),
    description: L(p.descriptionEn, p.descriptionHi),
    categoryId: p.categoryId,
    itemGroupId: p.itemGroupId ?? null,
    navLinkId: p.navLinkId ?? null,
    tags: parseStringArray(p.tags),
    basePrice: p.basePrice,
    baseSalePrice: p.baseSalePrice,
    images: p.images.map((i) => ({ mediaId: i.mediaId, alt: L(i.altEn, i.altHi) })),
    options: p.options.map((o) => ({
      id: o.id,
      name: L(o.nameEn, o.nameHi),
      type: o.type as 'swatch' | 'button',
      values: o.values.map((v) => ({ id: v.id, label: L(v.labelEn, v.labelHi), swatch: v.swatch })),
    })),
    variants: p.variants.map((v) => ({
      id: v.id,
      sku: v.sku,
      options: variantOptions(v.options),
      price: v.price,
      salePrice: v.salePrice,
      stock: v.stock,
      imageIds: parseStringArray(v.imageIds),
    })),
    weight: { value: p.weightValue, unit: p.weightUnit as 'g' | 'kg' },
    dimensions: { length: p.dimLength, width: p.dimWidth, height: p.dimHeight, unit: p.dimUnit as 'cm' | 'in' },
    specs: p.specs.map((s) => ({ id: s.id, label: L(s.labelEn, s.labelHi), value: L(s.valueEn, s.valueHi) })),
    materials: L(p.materialsEn, p.materialsHi),
    care: L(p.careEn, p.careHi),
    returnsAllowed: p.returnsAllowed,
    exchangeAllowed: p.exchangeAllowed,
    returnDays: p.returnDays,
    isFeatured: p.isFeatured,
    isBestseller: p.isBestseller,
    isNew: p.isNew,
    displayOrder: p.displayOrder,
    seo: { title: L(p.seoTitleEn, p.seoTitleHi), description: L(p.seoDescriptionEn, p.seoDescriptionHi) },
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

export function toAdminCategory(c: CategoryRow, productCount?: number) {
  return {
    id: c.id,
    slug: c.slug,
    name: L(c.nameEn, c.nameHi),
    description: L(c.descriptionEn, c.descriptionHi),
    imageId: c.imageId,
    bannerId: c.bannerId,
    displayOrder: c.displayOrder,
    isActive: c.isActive,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    ...(productCount === undefined ? {} : { productCount }),
  };
}

// ---------------------------------------------------------------------------------------------
// Storefront shape
// ---------------------------------------------------------------------------------------------

const effective = (v: { price: number; salePrice: number | null }) => v.salePrice ?? v.price;

export interface PublicReview {
  id: string;
  author: string;
  rating: number;
  title: string;
  body: string;
  date: string;
  edited: boolean;
  verifiedPurchase: boolean;
  photos: string[];
}

export type RatingDistribution = Record<'1' | '2' | '3' | '4' | '5', number>;

export interface ReviewSummary {
  rating: number;
  reviewCount: number;
  distribution: RatingDistribution;
  /** Newest few published reviews — only filled for the single-product endpoint. */
  recent: PublicReview[];
}

export const emptyDistribution = (): RatingDistribution => ({ '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 });
export const EMPTY_REVIEW_SUMMARY: ReviewSummary = { rating: 0, reviewCount: 0, distribution: emptyDistribution(), recent: [] };

/** Public shape: display name only — never the customer's email, phone, address or order. */
export function toPublicReview(r: { id: string; rating: number; title: string | null; body: string | null; createdAt: Date; editedAt: Date | null; customer: { name: string }; photos?: string | null }): PublicReview {
  let photos: string[] = [];
  if (r.photos) {
    try { photos = JSON.parse(r.photos as string); } catch {}
  }
  return {
    id: r.id,
    author: r.customer.name.trim() || 'Customer',
    rating: r.rating,
    title: r.title ?? '',
    body: r.body ?? '',
    date: r.createdAt.toISOString(),
    edited: r.editedAt !== null,
    // Every review is created only after the server finds a delivered order of this product for the
    // reviewing customer, so this is server-verified rather than client-claimed.
    verifiedPurchase: true,
    photos,
  };
}

export function toStorefrontProduct(p: ProductRow, reviews: ReviewSummary = EMPTY_REVIEW_SUMMARY) {
  const imageFor = (mediaId: string) => {
    const img = p.images.find((i) => i.mediaId === mediaId);
    return { src: mediaUrl(mediaId), alt: Lopt(img?.altEn ?? p.nameEn, img?.altHi ?? '') };
  };
  const gallery = p.images.map((i) => ({ src: mediaUrl(i.mediaId), alt: Lopt(i.altEn, i.altHi) }));
  const cheapest = p.variants.reduce<(typeof p.variants)[number] | null>(
    (best, v) => (best === null || effective(v) < effective(best) ? v : best),
    null,
  );

  return {
    id: p.id,
    slug: p.slug,
    name: Lopt(p.nameEn, p.nameHi),
    shortDescription: Lopt(p.shortDescriptionEn, p.shortDescriptionHi),
    description: Lopt(p.descriptionEn, p.descriptionHi),
    categoryId: p.category.slug,
    itemGroupId: p.itemGroupId ?? null,
    navLinkId: p.navLinkId ?? null,
    price: cheapest?.price ?? p.basePrice,
    ...(cheapest?.salePrice != null ? { salePrice: cheapest.salePrice } : {}),
    images: gallery,
    options: p.options.map((o) => ({
      id: o.id,
      name: Lopt(o.nameEn, o.nameHi),
      type: o.type as 'swatch' | 'button',
      values: o.values.map((v) => ({ id: v.id, label: Lopt(v.labelEn, v.labelHi), ...(v.swatch ? { swatch: v.swatch } : {}) })),
    })),
    variants: p.variants.map((v) => ({
      id: v.id,
      sku: v.sku,
      options: variantOptions(v.options),
      price: v.price,
      ...(v.salePrice != null ? { salePrice: v.salePrice } : {}),
      stock: v.stock,
      // Variant-specific images when set, otherwise the whole gallery (matches the mock behaviour).
      images: parseStringArray(v.imageIds).length ? parseStringArray(v.imageIds).map(imageFor) : gallery,
    })),
    materials: Lopt(p.materialsEn, p.materialsHi),
    care: Lopt(p.careEn, p.careHi),
    returnsAllowed: p.returnsAllowed,
    exchangeAllowed: p.exchangeAllowed,
    returnDays: p.returnDays,
    dimensions: storefrontDimensions(p),
    // Published reviews only (hidden ones never count). The full paginated list is /products/:slug/reviews.
    reviews: reviews.recent,
    rating: reviews.rating,
    reviewCount: reviews.reviewCount,
    reviewDistribution: reviews.distribution,
    tags: parseStringArray(p.tags),
    isFeatured: p.isFeatured,
    isBestseller: p.isBestseller,
    isNew: p.isNew,
    createdAt: p.createdAt.toISOString(),
    featuredRank: p.displayOrder,
  };
}

/** The storefront shows dimensions as free-text rows; rebuild them from the structured columns + specs. */
function storefrontDimensions(p: ProductRow) {
  const unit = p.dimUnit;
  const rows: Array<{ key: string; value: string }> = [];
  const push = (key: string, n: number | null) => n != null && rows.push({ key, value: `${n} ${unit}` });
  push('length', p.dimLength);
  push('width', p.dimWidth);
  push('height', p.dimHeight);
  if (p.weightValue != null) rows.push({ key: 'weight', value: `${p.weightValue} ${p.weightUnit}` });
  for (const s of p.specs) rows.push({ key: s.labelEn.toLowerCase().replace(/\s+/g, ''), value: s.valueEn });
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

export function toAdminStoreSettings(s: {
  nameEn: string; taglineEn: string; taglineHi: string; logoId: string | null;
  contactEmail: string; contactPhone: string; contactAddress: string; contactHoursEn: string; contactHoursHi: string;
  socialInstagram: string; socialPinterest: string; socialFacebook: string; socialYoutube: string;
  handlingMinDays: number; handlingMaxDays: number; maxQtyPerLine: number; lowStockThreshold: number; updatedAt: Date;
}) {
  return {
    name: s.nameEn,
    tagline: L(s.taglineEn, s.taglineHi),
    logoId: s.logoId,
    contact: { email: s.contactEmail, phone: s.contactPhone, address: s.contactAddress, hours: L(s.contactHoursEn, s.contactHoursHi) },
    social: { instagram: s.socialInstagram, pinterest: s.socialPinterest, facebook: s.socialFacebook, youtube: s.socialYoutube },
    handlingDays: { min: s.handlingMinDays, max: s.handlingMaxDays },
    maxQtyPerLine: s.maxQtyPerLine,
    lowStockThreshold: s.lowStockThreshold,
    updatedAt: s.updatedAt.toISOString(),
  };
}

export function toAdminShippingZone(z: {
  id: string; nameEn: string; countries: string;
  standardEnabled: boolean; standardRate: number; standardMinDays: number; standardMaxDays: number;
  expressEnabled: boolean; expressRate: number; expressMinDays: number; expressMaxDays: number;
}) {
  return {
    id: z.id,
    name: z.nameEn,
    countries: parseStringArray(z.countries),
    standard: { enabled: z.standardEnabled, rate: z.standardRate, minDays: z.standardMinDays, maxDays: z.standardMaxDays },
    express: { enabled: z.expressEnabled, rate: z.expressRate, minDays: z.expressMinDays, maxDays: z.expressMaxDays },
  };
}

export function toAdminTaxRule(r: { id: string; country: string; region: string; rate: number; label: string }) {
  return { id: r.id, country: r.country, region: r.region, rate: r.rate, label: r.label };
}

export function toAdminCurrencyConfig(c: { code: string; name: string; enabled: boolean; rate: number; fractionDigits: number; roundingIncrement: number }) {
  return { code: c.code, name: c.name, enabled: c.enabled, rate: c.rate, fractionDigits: c.fractionDigits, roundingIncrement: c.roundingIncrement };
}

// ---------------------------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------------------------
// Content: homepage + the 7 fixed information/policy pages
// ---------------------------------------------------------------------------------------------

function safeParseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function toAdminHomepage(row: { draftJson: string; publishedJson: string | null; publishedAt: Date | null; updatedAt: Date; updatedBy: string }) {
  return {
    draft: safeParseJson(row.draftJson, null),
    published: row.publishedJson ? safeParseJson(row.publishedJson, null) : null,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
  };
}

export function toAdminPageDoc(row: { key: string; isLegal: boolean; draftJson: string; publishedJson: string | null; publishedAt: Date | null; updatedAt: Date; updatedBy: string }) {
  return {
    key: row.key,
    isLegal: row.isLegal,
    draft: safeParseJson(row.draftJson, null),
    published: row.publishedJson ? safeParseJson(row.publishedJson, null) : null,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
  };
}

/** Recursively turns `{en,hi}` pairs into the storefront's `Localized` (hi omitted when empty), for
 *  arbitrary JSON content stored as admin's always-both-keys shape. */
function toStorefrontLocalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toStorefrontLocalized);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.en === 'string' && typeof obj.hi === 'string' && Object.keys(obj).length === 2) {
      return Lopt(obj.en, obj.hi);
    }
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, toStorefrontLocalized(v)]));
  }
  return value;
}

/** Resolves a hero/story `imageId` to a durable `/media/:id` URL (or null when unset). */
function resolveImage(obj: unknown): unknown {
  if (!obj || typeof obj !== 'object') return obj;
  const o = obj as Record<string, unknown>;
  if ('imageId' in o) {
    const { imageId, ...rest } = o;
    return { ...rest, image: typeof imageId === 'string' ? mediaUrl(imageId) : null };
  }
  return o;
}

export function toStorefrontHomepage(published: Record<string, unknown>) {
  const localized = toStorefrontLocalized(published) as Record<string, unknown>;
  return {
    ...localized,
    hero: resolveImage(localized.hero),
    story: resolveImage(localized.story),
  };
}

export function toStorefrontPageContent(published: Record<string, unknown>) {
  return toStorefrontLocalized(published);
}

// ---------------------------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------------------------

export function toCustomerPublic(c: { id: string; name: string; email: string; phone: string; createdAt: Date }) {
  return { id: c.id, name: c.name, email: c.email, phone: c.phone || undefined, createdAt: c.createdAt.toISOString(), isDemoAccount: false };
}

/** admin/src/types Customer shape (distinct from the storefront's User: `phone` is nullable rather
 *  than optional, and it carries addresses). `marketingOptIn` has no backing column yet — there is no
 *  opt-in checkbox anywhere in the real registration/profile flow — so it is reported as false. */
export function toAdminCustomerAccount(c: { id: string; name: string; email: string; phone: string; createdAt: Date }, addresses: ReturnType<typeof toSavedAddress>[]) {
  return { id: c.id, name: c.name, email: c.email, phone: c.phone || null, createdAt: c.createdAt.toISOString(), marketingOptIn: false, addresses };
}

export function toSavedAddress(a: {
  id: string; label: string; isDefault: boolean; fullName: string; phoneCountry: string; phone: string;
  country: string; line1: string; line2: string; city: string; region: string; postalCode: string;
}) {
  return {
    id: a.id,
    label: a.label,
    isDefault: a.isDefault,
    fullName: a.fullName,
    phoneCountry: a.phoneCountry,
    phone: a.phone,
    country: a.country,
    line1: a.line1,
    line2: a.line2 || undefined,
    city: a.city || undefined,
    region: a.region || undefined,
    postalCode: a.postalCode || undefined,
  };
}

// ---------------------------------------------------------------------------------------------
// Coupons
// ---------------------------------------------------------------------------------------------

export function toAdminCoupon(c: {
  id: string; code: string; description: string; type: string; value: number; maxDiscount: number | null; minOrder: number | null;
  startsAt: Date | null; endsAt: Date | null; isActive: boolean; usageLimit: number | null; perCustomerLimit: number | null;
  timesUsed: number; scope: string; productIds: string; categoryIds: string; createdAt: Date; updatedAt: Date;
}) {
  return {
    id: c.id,
    code: c.code,
    description: c.description,
    type: c.type as 'percentage' | 'fixed',
    value: c.value,
    maxDiscount: c.maxDiscount,
    minOrder: c.minOrder,
    startsAt: c.startsAt ? c.startsAt.toISOString() : null,
    endsAt: c.endsAt ? c.endsAt.toISOString() : null,
    isActive: c.isActive,
    usageLimit: c.usageLimit,
    perCustomerLimit: c.perCustomerLimit,
    timesUsed: c.timesUsed,
    scope: c.scope as 'all' | 'products' | 'categories',
    productIds: parseStringArray(c.productIds),
    categoryIds: parseStringArray(c.categoryIds),
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------------------------

export const ORDER_INCLUDE = {
  lines: true,
  events: { orderBy: { at: 'asc' as const } },
  notes: { orderBy: { at: 'asc' as const } },
} satisfies Prisma.OrderInclude;

export type OrderRow = Prisma.OrderGetPayload<{ include: typeof ORDER_INCLUDE }>;

/** The stored snapshot is always the full `{base, rates, asOf}` map (pricing.ts buildRateSnapshot);
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

export function toAdminOrder(o: OrderRow) {
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

export function toStorefrontOrder(o: OrderRow) {
  const timeline = o.events
    .filter((e) => e.type === 'created' || e.type === 'fulfilment' || e.type === 'cancelled')
    .map((e) => ({ status: e.type === 'created' ? 'placed' : (STOREFRONT_STATUS[e.message.split(':')[0]] ?? STOREFRONT_STATUS[o.fulfilmentStatus]), date: e.at.toISOString() }));
  return {
    id: o.id,
    number: o.number,
    createdAt: o.createdAt.toISOString(),
    userId: o.customerId ?? undefined,
    email: o.customerEmail,
    phone: o.customerPhone,
    lines: o.lines.map((l) => ({
      productId: l.productId,
      variantId: l.variantId,
      slug: l.slug,
      name: Lopt(l.nameEn, l.nameHi),
      variantLabel: l.variantLabelEn ? Lopt(l.variantLabelEn, l.variantLabelHi) : null,
      image: { src: l.imageUrl ? l.imageUrl : '', alt: Lopt(l.nameEn, l.nameHi) },
      unitPrice: l.unitPrice,
      quantity: l.quantity,
      lineTotal: l.lineTotal,
    })),
    currency: o.currency,
    rateSnapshot: toStorefrontRateSnapshot(o.rateSnapshotJson),
    subtotal: o.subtotal,
    discount: o.discount,
    ...(o.couponCode ? { couponCode: o.couponCode } : {}),
    shipping: o.shipping,
    tax: o.tax,
    taxRate: o.taxRate,
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

// ---------------------------------------------------------------------------------------------
// Admin customers (read-only, derived from orders + the Customer table)
// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// Navigation links + curated collections
// ---------------------------------------------------------------------------------------------

export function toAdminNavLink(n: { id: string; labelEn: string; labelHi: string; href: string; position: number; isActive: boolean }) {
  return { id: n.id, label: L(n.labelEn, n.labelHi), href: n.href, position: n.position, isActive: n.isActive };
}

export function toPublicNavLink(n: { id: string; labelEn: string; labelHi: string; href: string }) {
  return { id: n.id, label: Lopt(n.labelEn, n.labelHi), href: n.href };
}

type CollectionRow = Prisma.CollectionGetPayload<{ include: { circles: true; sections: true } }>;

export function toAdminCollection(c: CollectionRow) {
  return {
    id: c.id,
    slug: c.slug,
    title: L(c.titleEn, c.titleHi),
    subtitle: L(c.subtitleEn, c.subtitleHi),
    description: L(c.descriptionEn, c.descriptionHi),
    heroImageId: c.heroImageId,
    heroColor: c.heroColor,
    status: c.status as 'draft' | 'published',
    displayOrder: c.displayOrder,
    showInNavigation: c.showInNavigation,
    publishedAt: c.publishedAt ? c.publishedAt.toISOString() : null,
    circles: c.circles
      .sort((a, b) => a.position - b.position)
      .map((ci) => ({ id: ci.id, label: L(ci.labelEn, ci.labelHi), imageId: ci.imageId, linkType: ci.linkType as 'category' | 'collection' | 'url', linkValue: ci.linkValue })),
    sections: c.sections
      .sort((a, b) => a.position - b.position)
      .map((s) => ({ id: s.id, title: L(s.titleEn, s.titleHi), productIds: parseStringArray(s.productIds) })),
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

/** Published-only shape for the storefront, with products resolved per section and circle links
 *  rewritten to real hrefs. `resolveProduct` returns the storefront Product shape (or undefined if a
 *  referenced product is no longer active, in which case it is silently skipped). */
export function toStorefrontCollection(
  c: CollectionRow,
  resolveProduct: (id: string) => ReturnType<typeof toStorefrontProduct> | undefined,
) {
  const circleHref = (ci: CollectionRow['circles'][number]) => {
    if (ci.linkType === 'category') return `/category/${ci.linkValue}`;
    if (ci.linkType === 'collection') return `/collection/${ci.linkValue}`;
    return ci.linkValue;
  };
  return {
    slug: c.slug,
    title: Lopt(c.titleEn, c.titleHi),
    subtitle: Lopt(c.subtitleEn, c.subtitleHi),
    description: Lopt(c.descriptionEn, c.descriptionHi),
    heroImage: c.heroImageId ? mediaUrl(c.heroImageId) : null,
    heroColor: c.heroColor,
    circles: c.circles
      .sort((a, b) => a.position - b.position)
      .map((ci) => ({ label: Lopt(ci.labelEn, ci.labelHi), image: ci.imageId ? mediaUrl(ci.imageId) : null, href: circleHref(ci) })),
    sections: c.sections
      .sort((a, b) => a.position - b.position)
      .map((s) => ({
        title: Lopt(s.titleEn, s.titleHi),
        products: parseStringArray(s.productIds)
          .map(resolveProduct)
          .filter((p): p is ReturnType<typeof toStorefrontProduct> => !!p),
      })),
  };
}

export function toStorefrontCategory(c: CategoryRow) {
  return {
    id: c.slug,
    slug: c.slug,
    name: Lopt(c.nameEn, c.nameHi),
    description: Lopt(c.descriptionEn, c.descriptionHi),
    image: { src: c.imageId ? mediaUrl(c.imageId) : '', alt: Lopt(c.nameEn, c.nameHi) },
    banner: c.bannerId ? mediaUrl(c.bannerId) : '',
  };
}

// ---------------------------------------------------------------------------------------------
// Returns & Refunds (raw SQL rows — Prisma client not regenerated due to locked DLL)
// ---------------------------------------------------------------------------------------------

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
