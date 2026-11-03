import { Router } from 'express';
import { requireOwner } from '../auth.js';
import { prisma } from '../db.js';
import { notFound, route } from '../http.js';
import { toAdminNavLink, toPublicNavLink } from '../mappers.js';
import { navLinkInputSchema } from '../validation.js';

// Admin-managed secondary navigation row (e.g. Gifts, Top Gifts, Wedding Guide), shown site-wide on
// the storefront. Unrelated to the product catalogue's Category model.

export const navLinksRouter = Router();
export const publicNavLinksRouter = Router();

navLinksRouter.use(requireOwner);

navLinksRouter.get(
  '/',
  route(async (_req, res) => {
    const rows = await prisma.navLink.findMany({ orderBy: { position: 'asc' } });
    res.json({ items: rows.map(toAdminNavLink) });
  }),
);

navLinksRouter.post(
  '/',
  route(async (req, res) => {
    const input = navLinkInputSchema.parse(req.body);
    const row = await prisma.navLink.create({ data: { labelEn: input.labelEn, labelHi: input.labelHi, href: input.href, isActive: input.isActive, position: input.position } });
    res.status(201).json(toAdminNavLink(row));
  }),
);

navLinksRouter.put(
  '/:id',
  route(async (req, res) => {
    const existing = await prisma.navLink.findUnique({ where: { id: req.params.id } });
    if (!existing) throw notFound('Navigation link not found.');
    const input = navLinkInputSchema.parse(req.body);
    const row = await prisma.navLink.update({
      where: { id: existing.id },
      data: { labelEn: input.labelEn, labelHi: input.labelHi, href: input.href, isActive: input.isActive, position: input.position },
    });
    res.json(toAdminNavLink(row));
  }),
);

navLinksRouter.delete(
  '/:id',
  route(async (req, res) => {
    const existing = await prisma.navLink.findUnique({ where: { id: req.params.id } });
    if (!existing) throw notFound('Navigation link not found.');
    await prisma.navLink.delete({ where: { id: existing.id } });
    res.status(204).end();
  }),
);

/** Bulk reorder: body `{ ids: string[] }` in the new display order. */
navLinksRouter.post(
  '/reorder',
  route(async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? (req.body.ids as string[]) : [];
    await prisma.$transaction(ids.map((id, position) => prisma.navLink.update({ where: { id }, data: { position } })));
    const rows = await prisma.navLink.findMany({ orderBy: { position: 'asc' } });
    res.json({ items: rows.map(toAdminNavLink) });
  }),
);

// --- public (storefront) -------------------------------------------------------------------------

publicNavLinksRouter.get(
  '/',
  route(async (_req, res) => {
    const rows = await prisma.navLink.findMany({ where: { isActive: true }, orderBy: { position: 'asc' } });
    res.json({ items: rows.map(toPublicNavLink) });
  }),
);
