import { Router } from 'express';
import { route } from '../../shared/http/async-route.js';
import { listProductReviews, listStoreReviews } from './review.service.js';

// Public, anonymous endpoints: published reviews only, no private fields. The signed-in customer's own
// reviews are in customer-review.routes.ts, owner moderation in admin-review.routes.ts.

export const publicReviewsRouter = Router();

// GET /api/products/:slug/reviews
publicReviewsRouter.get(
  '/products/:slug/reviews',
  route(async (req, res) => {
    res.json(await listProductReviews(req.params.slug, req.query));
  }),
);

// GET /api/reviews — store-wide, each review tagged with the product it is about.
publicReviewsRouter.get(
  '/reviews',
  route(async (req, res) => {
    res.json(await listStoreReviews(req.query));
  }),
);
