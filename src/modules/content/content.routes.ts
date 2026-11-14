import { Router } from 'express';
import { prisma } from '../../shared/database/prisma.js';
import { route } from '../../shared/http/async-route.js';
import { toStorefrontHomepage, toStorefrontPageContent } from './content.mapper.js';
import { assertPageKey } from './content.service.js';

// Public (storefront) content: published only. A singleton/page with nothing published yet returns
// `published: false` and a null content — a real empty state, never a silent fallback to old sample copy.

export const publicContentRouter = Router();

publicContentRouter.get(
  '/homepage',
  route(async (_req, res) => {
    const row = await prisma.homepageContent.findUnique({ where: { id: 'singleton' } });
    if (!row?.publishedJson) return res.json({ published: false, content: null });
    res.json({ published: true, content: toStorefrontHomepage(JSON.parse(row.publishedJson)) });
  }),
);

publicContentRouter.get(
  '/pages/:key',
  route(async (req, res) => {
    assertPageKey(req.params.key);
    const row = await prisma.pageDoc.findUnique({ where: { key: req.params.key } });
    if (!row?.publishedJson) return res.json({ published: false, content: null });
    res.json({ published: true, content: toStorefrontPageContent(JSON.parse(row.publishedJson)) });
  }),
);
