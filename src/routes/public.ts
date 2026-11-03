import { Router } from 'express';
import { prisma } from '../db.js';
import { notFound, route } from '../http.js';
import { PRODUCT_INCLUDE, toStorefrontCategory, toStorefrontProduct } from '../mappers.js';
import { productReviewSummary, ratingSummaries } from '../reviewStats.js';

// Public catalog. Only `active` products inside `isActive` categories are ever visible here —
// draft and archived products must not leak through the list, search, related, or direct slug lookup.

export const publicRouter = Router();

const VISIBLE = { status: 'active', category: { isActive: true } } as const;

publicRouter.get(
  '/categories',
  route(async (_req, res) => {
    const rows = await prisma.category.findMany({ where: { isActive: true }, orderBy: [{ displayOrder: 'asc' }, { nameEn: 'asc' }] });
    res.json({ items: rows.map(toStorefrontCategory) });
  }),
);

publicRouter.get(
  '/products',
  route(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const categories = String(req.query.category ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const ids = String(req.query.ids ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 200));

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
    res.json({ items: rows.map((r) => toStorefrontProduct(r, ratings.get(r.id))), total: rows.length });
  }),
);

publicRouter.get(
  '/products/:slug',
  route(async (req, res) => {
    const row = await prisma.product.findFirst({ where: { slug: req.params.slug, ...VISIBLE }, include: PRODUCT_INCLUDE });
    // Deliberately 404 for draft/archived products: the public URL must not reveal that they exist.
    if (!row) throw notFound('Product not found.');
    res.json(toStorefrontProduct(row, await productReviewSummary(row.id)));
  }),
);
