import type { Prisma } from '@prisma/client';
import { mediaUrl } from '../../shared/config/env.js';
import { L } from '../../shared/utils/localized.js';

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

// --- store-wide public listing --------------------------------------------------------------------

export const STORE_REVIEW_INCLUDE = {
  customer: { select: { name: true } },
  product: { select: { slug: true, nameEn: true, nameHi: true, images: { orderBy: { position: 'asc' }, take: 1, select: { mediaId: true } } } },
} satisfies Prisma.ReviewInclude;
type StoreReviewRow = Prisma.ReviewGetPayload<{ include: typeof STORE_REVIEW_INCLUDE }>;

/** A public review tagged with the product it is about. */
export const toPublicStoreReview = (r: StoreReviewRow) => ({
  ...toPublicReview(r),
  product: { slug: r.product.slug, name: L(r.product.nameEn, r.product.nameHi), image: r.product.images[0] ? mediaUrl(r.product.images[0].mediaId) : null },
});

// --- customer's own reviews -----------------------------------------------------------------------

export const OWN_INCLUDE = { product: { select: { slug: true, nameEn: true, nameHi: true } } } as const;
type OwnReviewRow = Prisma.ReviewGetPayload<{ include: { product: { select: { slug: true; nameEn: true; nameHi: true } } } }>;

export const toOwnReview = (r: OwnReviewRow) => {
  let photos: string[] = [];
  if ((r as any).photos) { try { photos = JSON.parse((r as any).photos); } catch {} }
  return {
    id: r.id,
    productId: r.productId,
    productSlug: r.product.slug,
    productName: L(r.product.nameEn, r.product.nameHi),
    rating: r.rating,
    title: r.title ?? '',
    body: r.body ?? '',
    status: r.status as 'published' | 'hidden',
    createdAt: r.createdAt.toISOString(),
    editedAt: r.editedAt?.toISOString() ?? null,
    photos,
  };
};

// --- owner moderation -----------------------------------------------------------------------------

export const ADMIN_INCLUDE = {
  product: { select: { id: true, slug: true, nameEn: true, nameHi: true, status: true } },
  customer: { select: { id: true, name: true, email: true } },
  order: { select: { id: true, number: true } },
  moderationEvents: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.ReviewInclude;
type AdminReviewRow = Prisma.ReviewGetPayload<{ include: typeof ADMIN_INCLUDE }>;

export const toAdminReview = (r: AdminReviewRow) => ({
  id: r.id,
  status: r.status as 'published' | 'hidden',
  rating: r.rating,
  title: r.title ?? '',
  body: r.body ?? '',
  createdAt: r.createdAt.toISOString(),
  editedAt: r.editedAt?.toISOString() ?? null,
  product: { id: r.product.id, slug: r.product.slug, name: L(r.product.nameEn, r.product.nameHi), status: r.product.status },
  customer: { id: r.customer.id, name: r.customer.name, email: r.customer.email },
  order: { id: r.order.id, number: r.order.number },
  moderation: r.moderationEvents.map((e) => ({ id: e.id, action: e.action as 'hidden' | 'restored', reason: e.reason ?? '', at: e.createdAt.toISOString() })),
});
