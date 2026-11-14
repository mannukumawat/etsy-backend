import { Router } from 'express';
import { route } from '../../shared/http/async-route.js';
import { getStorefrontProductBySlug, listStorefrontProducts } from './storefront-product.service.js';

export const storefrontProductRouter = Router();

storefrontProductRouter.get(
  '/products',
  route(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const categories = String(req.query.category ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const ids = String(req.query.ids ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 200));
    res.json(await listStorefrontProducts({ q, categories, ids, limit }));
  }),
);

storefrontProductRouter.get(
  '/products/:slug',
  route(async (req, res) => {
    res.json(await getStorefrontProductBySlug(req.params.slug));
  }),
);
