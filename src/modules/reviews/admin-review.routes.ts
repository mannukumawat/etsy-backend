import { Router } from 'express';
import { route } from '../../shared/http/async-route.js';
import { requireOwner } from '../../shared/middleware/auth.middleware.js';
import { reviewModerationSchema } from './review.schema.js';
import { listAdminReviews, moderateReview } from './review.service.js';

// Owner moderation (/api/admin/reviews): hide/restore with a reason and an append-only history.
// (There is no GET /:id endpoint: the admin only ever calls list + hide/restore.)

export const adminReviewsRouter = Router();

adminReviewsRouter.use(requireOwner);

adminReviewsRouter.get(
  '/',
  route(async (req, res) => {
    res.json(await listAdminReviews(req.query));
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
