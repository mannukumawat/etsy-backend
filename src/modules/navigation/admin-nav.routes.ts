import { Router } from 'express';
import { prisma } from '../../shared/database/prisma.js';
import { route } from '../../shared/http/async-route.js';
import { requireOwner } from '../../shared/middleware/auth.middleware.js';
import { toAdminNavLink } from './nav.mapper.js';
import { navLinkInputSchema } from './nav.schema.js';
import { createNavLink, deleteNavLink, getNavLinkOrThrow, reorderNavLinks, updateNavLink } from './nav.service.js';

export const navLinksRouter = Router();

navLinksRouter.use(requireOwner);

navLinksRouter.get(
  '/',
  route(async (_req, res) => {
    const rows = await prisma.navLink.findMany({ orderBy: { position: 'asc' }, include: { _count: { select: { products: true } } } });
    res.json({ items: rows.map(toAdminNavLink) });
  }),
);

navLinksRouter.post(
  '/',
  route(async (req, res) => {
    const input = navLinkInputSchema.parse(req.body);
    res.status(201).json(toAdminNavLink(await createNavLink(input)));
  }),
);

navLinksRouter.put(
  '/:id',
  route(async (req, res) => {
    // The link must exist (404) before the body is validated (400).
    const existing = await getNavLinkOrThrow(req.params.id);
    const input = navLinkInputSchema.parse(req.body);
    res.json(toAdminNavLink(await updateNavLink(existing.id, input)));
  }),
);

navLinksRouter.delete(
  '/:id',
  route(async (req, res) => {
    await deleteNavLink(req.params.id);
    res.status(204).end();
  }),
);

/** Bulk reorder: body `{ ids: string[] }` in the new display order. */
navLinksRouter.post(
  '/reorder',
  route(async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? (req.body.ids as string[]) : [];
    const rows = await reorderNavLinks(ids);
    res.json({ items: rows.map(toAdminNavLink) });
  }),
);
