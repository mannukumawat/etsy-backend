import { prisma } from '../../shared/database/prisma.js';
import { notFound } from '../../shared/errors/http-error.js';
import { productReviewSummary, ratingSummaries } from '../reviews/review-stats.service.js';
import { PRODUCT_INCLUDE, toStorefrontProduct } from './product.mapper.js';
import type { StorefrontProductQuery } from './product.types.js';

// Public catalog. Only `active` products inside `isActive` categories are ever visible here —
// draft and archived products must not leak through the list, search, related, or direct slug lookup.

const VISIBLE = { status: 'active', category: { isActive: true } } as const;

export async function listStorefrontProducts({ q, categories, ids, limit }: StorefrontProductQuery) {
  const where = {
    ...VISIBLE,
    ...(ids.length ? { id: { in: ids } } : {}),
    ...(categories.length ? { category: { isActive: true, slug: { in: categories } } } : {}),
    // searchText is a pre-lowercased haystack (name + tags + SKUs), so matching is
    // case-insensitive on SQLite as well as PostgreSQL.
    ...(q ? { searchText: { contains: q.toLowerCase() } } : {}),
  };

  const rows = await prisma.product.findMany({ where, include: PRODUCT_INCLUDE, orderBy: [{ displayOrder: 'asc' }, { nameEn: 'asc' }], take: limit });
  const ratings = await ratingSummaries(rows.map((r) => r.id));
  return { items: rows.map((r) => toStorefrontProduct(r, ratings.get(r.id))), total: rows.length };
}

export async function getStorefrontProductBySlug(slug: string) {
  const row = await prisma.product.findFirst({ where: { slug, ...VISIBLE }, include: PRODUCT_INCLUDE });
  // Deliberately 404 for draft/archived products: the public URL must not reveal that they exist.
  if (!row) throw notFound('Product not found.');
  return toStorefrontProduct(row, await productReviewSummary(row.id));
}
