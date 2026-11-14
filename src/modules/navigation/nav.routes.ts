import { Router } from 'express';
import { prisma } from '../../shared/database/prisma.js';
import { route } from '../../shared/http/async-route.js';
import { toPublicNavLink } from './nav.mapper.js';

export const publicNavLinksRouter = Router();

publicNavLinksRouter.get(
  '/',
  route(async (_req, res) => {
    const rows = await prisma.navLink.findMany({ where: { isActive: true }, orderBy: { position: 'asc' } });
    res.json({ items: rows.map(toPublicNavLink) });
  }),
);
