import { Router } from 'express';
import { prisma } from '../../shared/database/prisma.js';
import { route } from '../../shared/http/async-route.js';
import { toItemGroup } from './item-group.mapper.js';
import { PRODUCT_INCLUDE, toStorefrontListProduct } from '../products/product.mapper.js';
import { ratingSummaries } from '../reviews/review-stats.service.js';

export const publicItemGroupsRouter = Router();

publicItemGroupsRouter.get(
  '/',
  route(async (_req, res) => {
    const rows = await prisma.itemGroup.findMany({ where: { isActive: true }, orderBy: { position: 'asc' } });
    res.json({ items: rows.map(toItemGroup) });
  }),
);

publicItemGroupsRouter.get(
  '/with-products',
  route(async (req, res) => {
    const limit = Math.min(12, Math.max(1, Number(req.query.limit) || 10));
    const groups = await prisma.itemGroup.findMany({
      where: { isActive: true },
      orderBy: { position: 'asc' },
      include: {
        products: {
          where: { status: 'active', category: { isActive: true } },
          orderBy: [{ displayOrder: 'asc' }, { nameEn: 'asc' }],
          take: limit,
          include: PRODUCT_INCLUDE,
        },
      },
    });
    const productIds = groups.flatMap((group) => group.products.map((product) => product.id));
    const ratings = await ratingSummaries(productIds);
    const items = groups
      .map((group) => ({
        ...toItemGroup(group),
        products: group.products.map((row) => {
          return toStorefrontListProduct(row, ratings.get(row.id));
        }),
      }))
      .filter((group) => group.products.length > 0);
    res.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    res.json({ items });
  }),
);
