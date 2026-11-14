import { Router } from 'express';
import { prisma } from '../../shared/database/prisma.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { route } from '../../shared/http/async-route.js';
import { requireCustomer } from '../../shared/middleware/customer-auth.middleware.js';
import { reviewWriteLimiter } from '../../shared/middleware/rate-limit.middleware.js';
import { OWN_INCLUDE, toOwnReview } from './review.mapper.js';
import { reviewCreateSchema, reviewInputSchema } from './review.schema.js';
import { createReview, deleteReview, editReview, getOwnReviewState, storeReviewPhoto } from './review.service.js';

// The signed-in customer's own reviews (/api/customer/reviews). Eligibility is verified server-side.

export const customerReviewsRouter = Router();

customerReviewsRouter.use(requireCustomer);

const REVIEW_PHOTO_MAX = 3 * 1024 * 1024; // 3 MB per photo

/** Upload a photo for a review. Returns mediaId + url. Customer-only. */
customerReviewsRouter.post(
  '/upload-photo',
  route(async (req, res) => {
    const ct = req.headers['content-type'] ?? '';
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    const mime = allowed.find((m) => ct.startsWith(m));
    if (!mime) throw new HttpError(400, 'bad_request', 'Only JPEG, PNG, and WebP images are accepted.');

    const chunks: Buffer[] = [];
    let total = 0;
    await new Promise<void>((resolve, reject) => {
      req.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > REVIEW_PHOTO_MAX) { req.destroy(); reject(new HttpError(413, 'too_large', 'Photo must be under 3 MB.')); return; }
        chunks.push(chunk);
      });
      req.on('end', resolve);
      req.on('error', reject);
    });

    const photo = await storeReviewPhoto(Buffer.concat(chunks), mime);
    res.status(201).json(photo);
  }),
);

customerReviewsRouter.get(
  '/',
  route(async (req, res) => {
    const rows = await prisma.review.findMany({ where: { customerId: req.customer!.sub }, include: OWN_INCLUDE, orderBy: { createdAt: 'desc' } });
    res.json({ items: rows.map(toOwnReview) });
  }),
);

/** Drives the storefront form state: already reviewed (edit) / eligible (write) / not eligible. */
customerReviewsRouter.get(
  '/product/:productId',
  route(async (req, res) => {
    res.json(await getOwnReviewState(req.customer!.sub, req.params.productId));
  }),
);

customerReviewsRouter.post(
  '/',
  reviewWriteLimiter,
  route(async (req, res) => {
    const input = reviewCreateSchema.parse(req.body);
    const review = await createReview(req.customer!.sub, input);
    res.status(201).json({ review });
  }),
);

customerReviewsRouter.put(
  '/:id',
  reviewWriteLimiter,
  route(async (req, res) => {
    const input = reviewInputSchema.parse(req.body);
    const review = await editReview(req.customer!.sub, req.params.id, input);
    res.json({ review });
  }),
);

customerReviewsRouter.delete(
  '/:id',
  reviewWriteLimiter,
  route(async (req, res) => {
    await deleteReview(req.customer!.sub, req.params.id);
    res.json({ ok: true });
  }),
);
