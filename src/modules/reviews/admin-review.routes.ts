import { Router } from 'express';
import { prisma } from '../../shared/database/prisma.js';
import { notFound } from '../../shared/errors/http-error.js';
import { route } from '../../shared/http/async-route.js';
import { requireOwner } from '../../shared/middleware/auth.middleware.js';
import { ADMIN_INCLUDE, toAdminReview } from './review.mapper.js';
import { reviewModerationSchema } from './review.schema.js';
import { listAdminReviews, moderateReview } from './review.service.js';

// Owner moderation (/api/admin/reviews): hide/restore with a reason and an append-only history.

export const adminReviewsRouter = Router();

adminReviewsRouter.use(requireOwner);

adminReviewsRouter.get(
  '/',
  route(async (req, res) => {
    res.json(await listAdminReviews(req.query));
  }),
);

adminReviewsRouter.get(
  '/:id',
  route(async (req, res) => {
    const row = await prisma.review.findUnique({ where: { id: req.params.id }, include: ADMIN_INCLUDE });
    if (!row) throw notFound('Review not found.');
    res.json(toAdminReview(row));
  }),
);

function moderate(action: 'hidden' | 'restored') {
  return route(async (req, res) => {
    const { reason } = reviewModerationSchema.parse(req.body);
    res.json(await moderateReview(req.params.id, action, reason));
  });
}

adminReviewsRouter.post('/:id/hide', moderate('hidden'));
adminReviewsRouter.post('/:id/restore', moderate('restored'));
