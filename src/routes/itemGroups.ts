import { Router } from 'express';
import { requireOwner } from '../auth.js';
import { prisma } from '../db.js';
import { notFound, route } from '../http.js';
import { z } from 'zod';

export const itemGroupsRouter = Router();
export const publicItemGroupsRouter = Router();

itemGroupsRouter.use(requireOwner);

const itemGroupSchema = z.object({
  nameEn: z.string().min(1).max(120),
  nameHi: z.string().max(120).default(''),
  slug: z.string().min(1).max(80).regex(/^[a-z0-9-]+$/, 'Slug: lowercase, numbers and hyphens only.'),
  position: z.number().int().default(100),
  isActive: z.boolean().default(true),
  imageId: z.string().nullable().optional(),
});

function toItemGroup(g: { id: string; nameEn: string; nameHi: string; slug: string; position: number; isActive: boolean; imageId: string | null; createdAt: Date; updatedAt: Date }) {
  return {
    id: g.id,
    nameEn: g.nameEn,
    nameHi: g.nameHi,
    slug: g.slug,
    position: g.position,
    isActive: g.isActive,
    imageId: g.imageId,
    createdAt: g.createdAt.toISOString(),
    updatedAt: g.updatedAt.toISOString(),
  };
}

itemGroupsRouter.get(
  '/',
  route(async (_req, res) => {
    const rows = await prisma.itemGroup.findMany({ orderBy: { position: 'asc' }, include: { _count: { select: { products: true } } } });
    res.json({ items: rows.map((g) => ({ ...toItemGroup(g), productCount: g._count.products })) });
  }),
);

itemGroupsRouter.post(
  '/',
  route(async (req, res) => {
    const input = itemGroupSchema.parse(req.body);
    const row = await prisma.itemGroup.create({ data: { nameEn: input.nameEn, nameHi: input.nameHi, slug: input.slug, position: input.position, isActive: input.isActive, imageId: input.imageId ?? null } });
    res.status(201).json(toItemGroup(row));
  }),
);

itemGroupsRouter.put(
  '/:id',
  route(async (req, res) => {
    const existing = await prisma.itemGroup.findUnique({ where: { id: req.params.id } });
    if (!existing) throw notFound('Item group not found.');
    const input = itemGroupSchema.parse(req.body);
    const row = await prisma.itemGroup.update({
      where: { id: existing.id },
      data: { nameEn: input.nameEn, nameHi: input.nameHi, slug: input.slug, position: input.position, isActive: input.isActive, imageId: input.imageId ?? null },
    });
    res.json(toItemGroup(row));
  }),
);

itemGroupsRouter.delete(
  '/:id',
  route(async (req, res) => {
    const existing = await prisma.itemGroup.findUnique({ where: { id: req.params.id } });
    if (!existing) throw notFound('Item group not found.');
    await prisma.itemGroup.delete({ where: { id: existing.id } });
    res.status(204).end();
  }),
);

itemGroupsRouter.post(
  '/reorder',
  route(async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? (req.body.ids as string[]) : [];
    await prisma.$transaction(ids.map((id, position) => prisma.itemGroup.update({ where: { id }, data: { position } })));
    const rows = await prisma.itemGroup.findMany({ orderBy: { position: 'asc' } });
    res.json({ items: rows.map(toItemGroup) });
  }),
);

// --- public --------------------------------------------------------------------------------------

publicItemGroupsRouter.get(
  '/',
  route(async (_req, res) => {
    const rows = await prisma.itemGroup.findMany({ where: { isActive: true }, orderBy: { position: 'asc' } });
    res.json({ items: rows.map(toItemGroup) });
  }),
);
