import { Router } from 'express';
import { prisma } from '../../shared/database/prisma.js';
import { route } from '../../shared/http/async-route.js';
import { toStorefrontCategory } from './category.mapper.js';

export const storefrontCategoryRouter = Router();

storefrontCategoryRouter.get(
  '/categories',
  route(async (_req, res) => {
    const rows = await prisma.category.findMany({ where: { isActive: true }, orderBy: [{ displayOrder: 'asc' }, { nameEn: 'asc' }] });
    res.json({ items: rows.map(toStorefrontCategory) });
  }),
);
