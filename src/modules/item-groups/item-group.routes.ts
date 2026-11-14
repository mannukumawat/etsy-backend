import { Router } from 'express';
import { prisma } from '../../shared/database/prisma.js';
import { route } from '../../shared/http/async-route.js';
import { toItemGroup } from './item-group.mapper.js';

export const publicItemGroupsRouter = Router();

publicItemGroupsRouter.get(
  '/',
  route(async (_req, res) => {
    const rows = await prisma.itemGroup.findMany({ where: { isActive: true }, orderBy: { position: 'asc' } });
    res.json({ items: rows.map(toItemGroup) });
  }),
);
