import { Router } from 'express';
import { prisma } from '../../shared/database/prisma.js';
import { route } from '../../shared/http/async-route.js';
import { requireOwner } from '../../shared/middleware/auth.middleware.js';
import { toAdminItemGroup, toItemGroup } from './item-group.mapper.js';
import { itemGroupInputSchema } from './item-group.schema.js';
import { createItemGroup, deleteItemGroup, getItemGroupOrThrow, reorderItemGroups, updateItemGroup } from './item-group.service.js';

export const itemGroupsRouter = Router();

itemGroupsRouter.use(requireOwner);

itemGroupsRouter.get(
  '/',
  route(async (_req, res) => {
    const rows = await prisma.itemGroup.findMany({ orderBy: { position: 'asc' }, include: { _count: { select: { products: true } } } });
    res.json({ items: rows.map(toAdminItemGroup) });
  }),
);

itemGroupsRouter.post(
  '/',
  route(async (req, res) => {
    const input = itemGroupInputSchema.parse(req.body);
    res.status(201).json(toItemGroup(await createItemGroup(input)));
  }),
);

itemGroupsRouter.put(
  '/:id',
  route(async (req, res) => {
    // The group must exist (404) before the body is validated (400).
    const existing = await getItemGroupOrThrow(req.params.id);
    const input = itemGroupInputSchema.parse(req.body);
    res.json(toItemGroup(await updateItemGroup(existing.id, input)));
  }),
);

itemGroupsRouter.delete(
  '/:id',
  route(async (req, res) => {
    await deleteItemGroup(req.params.id);
    res.status(204).end();
  }),
);

itemGroupsRouter.post(
  '/reorder',
  route(async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? (req.body.ids as string[]) : [];
    const rows = await reorderItemGroups(ids);
    res.json({ items: rows.map(toItemGroup) });
  }),
);
