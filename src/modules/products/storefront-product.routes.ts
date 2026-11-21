import { Router } from 'express';
import { route } from '../../shared/http/async-route.js';
import { getStorefrontProductBySlug, listStorefrontProducts } from './storefront-product.service.js';

export const storefrontProductRouter = Router();

/** Catalogue grid page size (M6): the old 200-row default hydrated and shipped far more than any grid shows. */
const STOREFRONT_DEFAULT_LIMIT = 24;
/** Hard cap: no catalogue page ever returns more than this many rows. */
const STOREFRONT_MAX_LIMIT = 200;

storefrontProductRouter.get(
  '/products',
  route(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const categories = String(req.query.category ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const ids = String(req.query.ids ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const limit = Math.min(STOREFRONT_MAX_LIMIT, Math.max(1, Number(req.query.limit) || STOREFRONT_DEFAULT_LIMIT));
    const page = Math.max(1, Math.floor(Number(req.query.page) || 1));
    res.set('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60');
    res.json(await listStorefrontProducts({ q, categories, ids, page, limit }));
  }),
);

storefrontProductRouter.get(
  '/products/:slug',
  route(async (req, res) => {
    res.set('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60');
    res.json(await getStorefrontProductBySlug(req.params.slug));
  }),
);
