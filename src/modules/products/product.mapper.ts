import type { Prisma } from '@prisma/client';
import { mediaUrl } from '../../shared/config/env.js';
import { parseStringArray, parseStringMap } from '../../shared/utils/json.js';
import { L, Lopt } from '../../shared/utils/localized.js';
import { EMPTY_REVIEW_SUMMARY, type ReviewSummary } from '../reviews/review.mapper.js';

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

// ---------------------------------------------------------------------------------------------
// Storefront shape
// ---------------------------------------------------------------------------------------------

const effective = (v: { price: number; salePrice: number | null }) => v.salePrice ?? v.price;

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
