import { prisma } from '../../shared/database/prisma.js';
import { notFound } from '../../shared/errors/http-error.js';
import { productReviewSummary, ratingSummaries } from '../reviews/review-stats.service.js';
import { PRODUCT_INCLUDE, PRODUCT_LIST_SELECT, toStorefrontListRow, toStorefrontProduct, type ProductListRow } from './product.mapper.js';
import { buildProductSearchQuery } from './product-search.js';
import type { StorefrontProductQuery } from './product.types.js';

// Public catalog. Only `active` products inside `isActive` categories are ever visible here —
// draft and archived products must not leak through the list, search, related, or direct slug lookup.

const VISIBLE = { status: 'active', category: { isActive: true } } as const;

/** Facet category lookup is a helper for the grid, not the result itself: cap it. */
const FACET_CATEGORY_LIMIT = 100;

export async function listStorefrontProducts({ q, categories, ids, page, limit }: StorefrontProductQuery) {
  // M7: full-text search uses the @@fulltext([searchText]) index. The matching ids
  // come back from one MATCH...AGAINST query (bound parameter, never interpolated)
  // and the normal Prisma filters then apply on top. Short queries fall back to
  // the LIKE path — MySQL full-text cannot see words under 4 characters.
  let searchWhere = {};
  let matchIds: string[] | null = null;
  if (q) {
    const search = buildProductSearchQuery(q);
    if (search.mode === 'fulltext') {
      const matches = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM products WHERE MATCH(searchText) AGAINST(${search.booleanQuery} IN BOOLEAN MODE)
      `;
      matchIds = matches.map((m: { id: string }) => m.id);
    } else {
      // searchText is a pre-lowercased haystack (name + tags + SKUs), and the query is
      // lowercased too, so the LIKE fallback matches case-insensitively.
      searchWhere = { searchText: { contains: q.toLowerCase() } };
    }
  }
  // An explicit `ids` filter and a full-text search both constrain by id: intersect
  // them instead of letting one silently overwrite the other.
  const effectiveIds = matchIds !== null && ids.length ? ids.filter((id) => matchIds!.includes(id)) : (matchIds ?? (ids.length ? ids : null));
  const where = {
    ...VISIBLE,
    ...(effectiveIds ? { id: { in: effectiveIds } } : {}),
    ...(categories.length ? { category: { isActive: true, slug: { in: categories } } } : {}),
    ...searchWhere,
  };
  // Facet counts are computed over the full filtered set, not the page: category
  // counts ignore the category filter itself (like the storefront's client-side
  // facets), so selecting a category does not zero out the other counts.
  const facetWhere = {
    ...VISIBLE,
    ...(effectiveIds ? { id: { in: effectiveIds } } : {}),
    ...searchWhere,
  };

  const total = await prisma.product.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / limit));
  // M6: a page past the end returns an EMPTY page for that page number — the old
  // silent clamp to the last page made the storefront show page 3's products
  // while the URL said page 99.
  const [rows, categoryGroups, inStock] = await Promise.all([
    prisma.product.findMany({
      where,
      // M6: list-only select — the grid never sees the full options/specs/images
      // hydration the detail endpoint needs (see PRODUCT_LIST_SELECT).
      select: PRODUCT_LIST_SELECT,
      orderBy: [{ displayOrder: 'asc' }, { nameEn: 'asc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.product.groupBy({ by: ['categoryId'], where: facetWhere, _count: { _all: true } }),
    prisma.product.count({ where: { ...where, variants: { some: { stock: { gt: 0 } } } } }),
  ]);
  const ratings = await ratingSummaries(rows.map((r: { id: string }) => r.id));
  // groupBy returns category ids; the storefront keys facet counts by slug.
  const slugById = new Map<string, string>(
    (await prisma.category.findMany({ select: { id: true, slug: true }, take: FACET_CATEGORY_LIMIT })).map(
      (c: { id: string; slug: string }) => [c.id, c.slug] as [string, string],
    ),
  );
  const categoryFacets: Record<string, number> = {};
  for (const group of categoryGroups as Array<{ categoryId: string; _count: { _all: number } }>) {
    const slug = slugById.get(group.categoryId);
    if (slug) categoryFacets[slug] = group._count._all;
  }
  return {
    items: rows.map((r: ProductListRow) => toStorefrontListRow(r, ratings.get(r.id))),
    // Full filtered count (previously the returned page size) — the shop's
    // infinite scroll needs it for its result count and page count.
    total,
    page,
    pageSize: limit,
    pageCount,
    facets: { categories: categoryFacets, availability: { in_stock: inStock, out_of_stock: total - inStock } },
  };
}

export async function getStorefrontProductBySlug(slug: string) {
  const row = await prisma.product.findFirst({ where: { slug, ...VISIBLE }, include: PRODUCT_INCLUDE });
  // Deliberately 404 for draft/archived products: the public URL must not reveal that they exist.
  if (!row) throw notFound('Product not found.');
  return toStorefrontProduct(row, await productReviewSummary(row.id));
}
