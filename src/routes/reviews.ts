import { Prisma } from '@prisma/client';
import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { requireOwner } from '../auth.js';
import { requireCustomer } from '../customerAuth.js';
import { prisma } from '../db.js';
import { HttpError, notFound, route } from '../http.js';
import { L, toPublicReview } from '../mappers.js';
import { mediaUrl } from '../env.js';
import { reviewWriteLimiter } from '../rateLimit.js';
import { PUBLISHED, productReviewSummary } from '../reviewStats.js';
import { reviewCreateSchema, reviewInputSchema, reviewModerationSchema } from '../validation.js';

// Three routers, three audiences:
//   publicReviewsRouter   — GET /api/products/:slug/reviews (published only, no private fields)
//   customerReviewsRouter — /api/customer/reviews (own reviews; eligibility verified server-side)
//   adminReviewsRouter    — /api/admin/reviews (owner moderation: hide/restore with reason + history)

export const publicReviewsRouter = Router();
export const customerReviewsRouter = Router();
export const adminReviewsRouter = Router();

const VISIBLE_PRODUCT = { status: 'active', category: { isActive: true } } as const;
const notEligible = () =>
  new HttpError(403, 'not_eligible', 'Only customers who have received this product can review it. You can review it once an order containing it has been delivered.');
const alreadyReviewed = () => new HttpError(409, 'already_reviewed', 'You have already reviewed this product. Edit your existing review instead.');

function page(req: { query: Record<string, unknown> }, maxSize: number, defaultSize: number) {
  const p = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
  const size = Math.min(maxSize, Math.max(1, parseInt(String(req.query.pageSize ?? String(defaultSize)), 10) || defaultSize));
  return { page: p, pageSize: size };
}

const SORTS: Record<string, Prisma.ReviewOrderByWithRelationInput[]> = {
  newest: [{ createdAt: 'desc' }, { id: 'desc' }],
  oldest: [{ createdAt: 'asc' }, { id: 'asc' }],
  highest: [{ rating: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
  lowest: [{ rating: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
};

const ratingFilter = (v: unknown) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : undefined;
};

// --- public ---------------------------------------------------------------------------------------

publicReviewsRouter.get(
  '/products/:slug/reviews',
  route(async (req, res) => {
    const product = await prisma.product.findFirst({ where: { slug: req.params.slug, ...VISIBLE_PRODUCT }, select: { id: true } });
    if (!product) throw notFound('Product not found.');
    const { page: p, pageSize } = page(req, 20, 5);
    const sort = SORTS[String(req.query.sort)] && req.query.sort !== 'oldest' ? String(req.query.sort) : 'newest';
    const rating = ratingFilter(req.query.rating);
    const where = { ...PUBLISHED, productId: product.id, ...(rating ? { rating } : {}) };

    const [summary, total] = await Promise.all([productReviewSummary(product.id, 0), prisma.review.count({ where })]);
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const current = Math.min(p, pageCount);
    const rows = await prisma.review.findMany({
      where,
      orderBy: SORTS[sort],
      skip: (current - 1) * pageSize,
      take: pageSize,
      include: { customer: { select: { name: true } } },
    });

    res.json({
      items: rows.map(toPublicReview),
      total,
      page: current,
      pageCount,
      pageSize,
      sort,
      rating: rating ?? null,
      summary: { average: summary.rating, count: summary.reviewCount, distribution: summary.distribution },
    });
  }),
);

/** Store-wide ("all reviews from this shop"): published reviews of currently visible products, each
 *  tagged with the product it's about. Same visibility rule and private-field exclusions as above. */
publicReviewsRouter.get(
  '/reviews',
  route(async (req, res) => {
    const { page: p, pageSize } = page(req, 24, 8);
    const sort = SORTS[String(req.query.sort)] && req.query.sort !== 'oldest' ? String(req.query.sort) : 'newest';
    const where = { ...PUBLISHED, product: VISIBLE_PRODUCT };
    const [total, agg] = await Promise.all([prisma.review.count({ where }), prisma.review.aggregate({ where, _avg: { rating: true } })]);
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const current = Math.min(p, pageCount);
    const rows = await prisma.review.findMany({
      where,
      orderBy: SORTS[sort],
      skip: (current - 1) * pageSize,
      take: pageSize,
      include: {
        customer: { select: { name: true } },
        product: { select: { slug: true, nameEn: true, nameHi: true, images: { orderBy: { position: 'asc' }, take: 1, select: { mediaId: true } } } },
      },
    });
    res.json({
      items: rows.map((r) => ({
        ...toPublicReview(r),
        product: { slug: r.product.slug, name: L(r.product.nameEn, r.product.nameHi), image: r.product.images[0] ? mediaUrl(r.product.images[0].mediaId) : null },
      })),
      total,
      page: current,
      pageCount,
      pageSize,
      summary: { average: Math.round((agg._avg.rating ?? 0) * 10) / 10, count: total },
    });
  }),
);

// --- customer -------------------------------------------------------------------------------------

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

    const buf = Buffer.concat(chunks);
    const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
    const id = `rp_${randomBytes(12).toString('hex')}`;
    await prisma.media.create({
      data: { id, fileName: `review-photo-${id}.${ext}`, mimeType: mime, sizeBytes: buf.length, data: buf, source: 'upload' },
    });
    res.status(201).json({ id, url: mediaUrl(id) });
  }),
);

type OwnReviewRow = Prisma.ReviewGetPayload<{ include: { product: { select: { slug: true; nameEn: true; nameHi: true } } } }>;
const toOwnReview = (r: OwnReviewRow) => {
  let photos: string[] = [];
  if ((r as any).photos) { try { photos = JSON.parse((r as any).photos); } catch {} }
  return {
    id: r.id,
    productId: r.productId,
    productSlug: r.product.slug,
    productName: L(r.product.nameEn, r.product.nameHi),
    rating: r.rating,
    title: r.title ?? '',
    body: r.body ?? '',
    status: r.status as 'published' | 'hidden',
    createdAt: r.createdAt.toISOString(),
    editedAt: r.editedAt?.toISOString() ?? null,
    photos,
  };
};
const OWN_INCLUDE = { product: { select: { slug: true, nameEn: true, nameHi: true } } } as const;

/** Most recent delivered order of this customer containing the product, or null. */
function qualifyingOrder(customerId: string, productId: string) {
  return prisma.order.findFirst({
    where: { customerId, customerKind: 'account', fulfilmentStatus: 'delivered', lines: { some: { productId } } },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
}

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
    const customerId = req.customer!.sub;
    const [existing, order] = await Promise.all([
      prisma.review.findUnique({ where: { customerId_productId: { customerId, productId: req.params.productId } }, include: OWN_INCLUDE }),
      qualifyingOrder(customerId, req.params.productId),
    ]);
    res.json({ eligible: !!order, review: existing ? toOwnReview(existing) : null });
  }),
);

customerReviewsRouter.post(
  '/',
  reviewWriteLimiter,
  route(async (req, res) => {
    const input = reviewCreateSchema.parse(req.body);
    const customerId = req.customer!.sub;
    const product = await prisma.product.findUnique({ where: { id: input.productId }, select: { id: true } });
    if (!product) throw notFound('Product not found.');

    const existing = await prisma.review.findUnique({ where: { customerId_productId: { customerId, productId: product.id } }, select: { id: true } });
    if (existing) throw alreadyReviewed();
    const order = await qualifyingOrder(customerId, product.id);
    if (!order) throw notEligible();

    try {
      const created = await prisma.review.create({
        // Identity, order and status come from the server, never from the request body.
        data: { productId: product.id, customerId, orderId: order.id, rating: input.rating, title: input.title, body: input.body, status: 'published' },
        include: OWN_INCLUDE,
      });
      const photosJson = JSON.stringify(input.photos ?? []);
      await prisma.$executeRaw`UPDATE reviews SET photos = ${photosJson} WHERE id = ${created.id}`;
      (created as any).photos = photosJson;
      res.status(201).json({ review: toOwnReview(created) });
    } catch (e) {
      // Two concurrent submissions: the (customerId, productId) unique index lets exactly one win.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw alreadyReviewed();
      throw e;
    }
  }),
);

async function ownReview(customerId: string, id: string) {
  const row = await prisma.review.findUnique({ where: { id }, select: { id: true, customerId: true } });
  // Same 404 whether it doesn't exist or belongs to someone else — no ownership oracle.
  if (!row || row.customerId !== customerId) throw notFound('Review not found.');
  return row;
}

customerReviewsRouter.put(
  '/:id',
  reviewWriteLimiter,
  route(async (req, res) => {
    const input = reviewInputSchema.parse(req.body);
    await ownReview(req.customer!.sub, req.params.id);
    // `status` is deliberately not touched: editing never un-hides an owner-hidden review.
    const updated = await prisma.review.update({
      where: { id: req.params.id },
      data: { rating: input.rating, title: input.title, body: input.body, editedAt: new Date() },
      include: OWN_INCLUDE,
    });
    const photosJson = JSON.stringify(input.photos ?? []);
    await prisma.$executeRaw`UPDATE reviews SET photos = ${photosJson} WHERE id = ${updated.id}`;
    (updated as any).photos = photosJson;
    res.json({ review: toOwnReview(updated) });
  }),
);

customerReviewsRouter.delete(
  '/:id',
  reviewWriteLimiter,
  route(async (req, res) => {
    await ownReview(req.customer!.sub, req.params.id);
    await prisma.review.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  }),
);

// --- admin moderation -----------------------------------------------------------------------------

adminReviewsRouter.use(requireOwner);

const ADMIN_INCLUDE = {
  product: { select: { id: true, slug: true, nameEn: true, nameHi: true, status: true } },
  customer: { select: { id: true, name: true, email: true } },
  order: { select: { id: true, number: true } },
  moderationEvents: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.ReviewInclude;
type AdminReviewRow = Prisma.ReviewGetPayload<{ include: typeof ADMIN_INCLUDE }>;

const toAdminReview = (r: AdminReviewRow) => ({
  id: r.id,
  status: r.status as 'published' | 'hidden',
  rating: r.rating,
  title: r.title ?? '',
  body: r.body ?? '',
  createdAt: r.createdAt.toISOString(),
  editedAt: r.editedAt?.toISOString() ?? null,
  product: { id: r.product.id, slug: r.product.slug, name: L(r.product.nameEn, r.product.nameHi), status: r.product.status },
  customer: { id: r.customer.id, name: r.customer.name, email: r.customer.email },
  order: { id: r.order.id, number: r.order.number },
  moderation: r.moderationEvents.map((e) => ({ id: e.id, action: e.action as 'hidden' | 'restored', reason: e.reason ?? '', at: e.createdAt.toISOString() })),
});

adminReviewsRouter.get(
  '/',
  route(async (req, res) => {
    const { page: p, pageSize } = page(req, 100, 20);
    const status = req.query.status === 'published' || req.query.status === 'hidden' ? req.query.status : undefined;
    const rating = ratingFilter(req.query.rating);
    const productId = String(req.query.productId ?? '').trim() || undefined;
    const q = String(req.query.q ?? '').trim();
    const from = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from)) ? new Date(`${req.query.from}T00:00:00.000Z`) : undefined;
    const to = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to)) ? new Date(`${req.query.to}T23:59:59.999Z`) : undefined;
    const sort = SORTS[String(req.query.sort)] ? String(req.query.sort) : 'newest';

    const where: Prisma.ReviewWhereInput = {
      ...(status ? { status } : {}),
      ...(rating ? { rating } : {}),
      ...(productId ? { productId } : {}),
      ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      ...(q
        ? {
            OR: [
              { title: { contains: q } },
              { body: { contains: q } },
              { customer: { name: { contains: q } } },
              { customer: { email: { contains: q.toLowerCase() } } },
              { product: { nameSearch: { contains: q.toLowerCase() } } },
            ],
          }
        : {}),
    };

    const [total, counts] = await Promise.all([prisma.review.count({ where }), prisma.review.groupBy({ by: ['status'], _count: { _all: true } })]);
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const current = Math.min(p, pageCount);
    const rows = await prisma.review.findMany({ where, include: ADMIN_INCLUDE, orderBy: SORTS[sort], skip: (current - 1) * pageSize, take: pageSize });
    const byStatus = Object.fromEntries(counts.map((c) => [c.status, c._count._all]));

    res.json({
      items: rows.map(toAdminReview),
      total,
      page: current,
      pageCount,
      pageSize,
      counts: { published: byStatus.published ?? 0, hidden: byStatus.hidden ?? 0 },
    });
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

/** Only `status` changes, plus an appended history event — the customer's rating/title/body are
 *  never rewritten. The same controls apply to any rating, high or low. */
function moderate(action: 'hidden' | 'restored') {
  return route(async (req, res) => {
    const { reason } = reviewModerationSchema.parse(req.body);
    const target = action === 'hidden' ? 'hidden' : 'published';
    const row = await prisma.review.findUnique({ where: { id: req.params.id }, select: { status: true } });
    if (!row) throw notFound('Review not found.');
    if (row.status === target) throw new HttpError(409, 'conflict', action === 'hidden' ? 'This review is already hidden.' : 'This review is already published.');

    await prisma.$transaction([
      prisma.review.update({ where: { id: req.params.id }, data: { status: target } }),
      prisma.reviewModerationEvent.create({ data: { reviewId: req.params.id, action, reason } }),
    ]);
    const updated = await prisma.review.findUniqueOrThrow({ where: { id: req.params.id }, include: ADMIN_INCLUDE });
    res.json(toAdminReview(updated));
  });
}

adminReviewsRouter.post('/:id/hide', moderate('hidden'));
adminReviewsRouter.post('/:id/restore', moderate('restored'));
