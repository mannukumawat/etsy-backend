import { Router } from 'express';
import { prisma } from '../../shared/database/prisma.js';
import { route } from '../../shared/http/async-route.js';
import { toAdminCategory } from './category.mapper.js';
import { categoryInputSchema } from './category.schema.js';
import { createCategory, updateCategory } from './category.service.js';

export const categoryRouter = Router();

categoryRouter.get(
  '/',
  route(async (_req, res) => {
    const rows = await prisma.category.findMany({
      orderBy: [{ displayOrder: 'asc' }, { nameEn: 'asc' }],
      include: { _count: { select: { products: true } } },
    });
    res.json({ items: rows.map((c) => toAdminCategory(c, c._count.products)) });
  }),
);

categoryRouter.post(
  '/',
  route(async (req, res) => {
    const input = categoryInputSchema.parse(req.body);
    const category = await createCategory(input);
    res.status(201).json(category);
  }),
);

categoryRouter.put(
  '/:id',
  route(async (req, res) => {
    const input = categoryInputSchema.parse(req.body);
    const category = await updateCategory(req.params.id, input);
    res.json(category);
  }),
);
