import { Prisma } from '@prisma/client';
import { mediaUrl } from '../../shared/config/env.js';
import { prisma } from '../../shared/database/prisma.js';
import { HttpError, notFound } from '../../shared/errors/http-error.js';
import { randomHexId } from '../../shared/utils/ids.js';
import { PUBLISHED, productReviewSummary } from './review-stats.service.js';
import { ADMIN_INCLUDE, OWN_INCLUDE, STORE_REVIEW_INCLUDE, toAdminReview, toOwnReview, toPublicReview, toPublicStoreReview } from './review.mapper.js';
import type { ReviewCreateInput, ReviewInput } from './review.schema.js';

/** Raw (unparsed) query-string values of the list endpoints, exactly as Express hands them over. Page,
 *  page size, sort and filters are normalised leniently here — bad values fall back to defaults. */
type ListQuery = Record<string, unknown>;

const VISIBLE_PRODUCT = { status: 'active', category: { isActive: true } } as const;
const notEligible = () =>
  new HttpError(403, 'not_eligible', 'Only customers who have received this product can review it. You can review it once an order containing it has been delivered.');
const alreadyReviewed = () => new HttpError(409, 'already_reviewed', 'You have already reviewed this product. Edit your existing review instead.');

function page(query: ListQuery, maxSize: number, defaultSize: number) {
  const p = Math.max(1, parseInt(String(query.page ?? '1'), 10) || 1);
  const size = Math.min(maxSize, Math.max(1, parseInt(String(query.pageSize ?? String(defaultSize)), 10) || defaultSize));
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

/** Published reviews of one visible product, with the rating summary. */
export async function listProductReviews(slug: string, query: ListQuery) {
  const product = await prisma.product.findFirst({ where: { slug, ...VISIBLE_PRODUCT }, select: { id: true } });
  if (!product) throw notFound('Product not found.');
  const { page: p, pageSize } = page(query, 20, 5);
  const sort = SORTS[String(query.sort)] && query.sort !== 'oldest' ? String(query.sort) : 'newest';
  const rating = ratingFilter(query.rating);
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

  return {
    items: rows.map(toPublicReview),
    total,
    page: current,
    pageCount,
    pageSize,
    sort,
    rating: rating ?? null,
    summary: { average: summary.rating, count: summary.reviewCount, distribution: summary.distribution },
  };
}

/** Store-wide ("all reviews from this shop"): published reviews of currently visible products, each
 *  tagged with the product it's about. Same visibility rule and private-field exclusions as above. */
export async function listStoreReviews(query: ListQuery) {
  const { page: p, pageSize } = page(query, 24, 8);
  const sort = SORTS[String(query.sort)] && query.sort !== 'oldest' ? String(query.sort) : 'newest';
  const where = { ...PUBLISHED, product: VISIBLE_PRODUCT };
  const [total, agg] = await Promise.all([prisma.review.count({ where }), prisma.review.aggregate({ where, _avg: { rating: true } })]);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(p, pageCount);
  const rows = await prisma.review.findMany({
    where,
    orderBy: SORTS[sort],
    skip: (current - 1) * pageSize,
    take: pageSize,
    include: STORE_REVIEW_INCLUDE,
  });
  return {
    items: rows.map(toPublicStoreReview),
    total,
    page: current,
    pageCount,
    pageSize,
    summary: { average: Math.round((agg._avg.rating ?? 0) * 10) / 10, count: total },
  };
}

// --- customer -------------------------------------------------------------------------------------

/** Stores an uploaded review photo as a media row. Returns its id and public URL. */
export async function storeReviewPhoto(buf: Buffer, mime: string) {
  const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
  const id = `rp_${randomHexId(12)}`;
  await prisma.media.create({
    data: { id, fileName: `review-photo-${id}.${ext}`, mimeType: mime, sizeBytes: buf.length, data: buf, source: 'upload' },
  });
  return { id, url: mediaUrl(id) };
}

/** Most recent delivered order of this customer containing the product, or null. */
function qualifyingOrder(customerId: string, productId: string) {
  return prisma.order.findFirst({
    where: { customerId, customerKind: 'account', fulfilmentStatus: 'delivered', lines: { some: { productId } } },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
}

/** Drives the storefront form state: already reviewed (edit) / eligible (write) / not eligible. */
export async function getOwnReviewState(customerId: string, productId: string) {
  const [existing, order] = await Promise.all([
    prisma.review.findUnique({ where: { customerId_productId: { customerId, productId } }, include: OWN_INCLUDE }),
    qualifyingOrder(customerId, productId),
  ]);
  return { eligible: !!order, review: existing ? toOwnReview(existing) : null };
}

export async function createReview(customerId: string, input: ReviewCreateInput) {
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
    return toOwnReview(created);
  } catch (e) {
    // Two concurrent submissions: the (customerId, productId) unique index lets exactly one win.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw alreadyReviewed();
    throw e;
  }
}

async function ownReview(customerId: string, id: string) {
  const row = await prisma.review.findUnique({ where: { id }, select: { id: true, customerId: true } });
  // Same 404 whether it doesn't exist or belongs to someone else — no ownership oracle.
  if (!row || row.customerId !== customerId) throw notFound('Review not found.');
  return row;
}

export async function editReview(customerId: string, id: string, input: ReviewInput) {
  await ownReview(customerId, id);
  // `status` is deliberately not touched: editing never un-hides an owner-hidden review.
  const updated = await prisma.review.update({
    where: { id },
    data: { rating: input.rating, title: input.title, body: input.body, editedAt: new Date() },
    include: OWN_INCLUDE,
  });
  const photosJson = JSON.stringify(input.photos ?? []);
  await prisma.$executeRaw`UPDATE reviews SET photos = ${photosJson} WHERE id = ${updated.id}`;
  (updated as any).photos = photosJson;
  return toOwnReview(updated);
}

export async function deleteReview(customerId: string, id: string) {
  await ownReview(customerId, id);
  await prisma.review.delete({ where: { id } });
}

// --- admin moderation -----------------------------------------------------------------------------

export async function listAdminReviews(query: ListQuery) {
  const { page: p, pageSize } = page(query, 100, 20);
  const status = query.status === 'published' || query.status === 'hidden' ? query.status : undefined;
  const rating = ratingFilter(query.rating);
  const productId = String(query.productId ?? '').trim() || undefined;
  const q = String(query.q ?? '').trim();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(String(query.from)) ? new Date(`${query.from}T00:00:00.000Z`) : undefined;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(String(query.to)) ? new Date(`${query.to}T23:59:59.999Z`) : undefined;
  const sort = SORTS[String(query.sort)] ? String(query.sort) : 'newest';

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

  return {
    items: rows.map(toAdminReview),
    total,
    page: current,
    pageCount,
    pageSize,
    counts: { published: byStatus.published ?? 0, hidden: byStatus.hidden ?? 0 },
  };
}

/** Only `status` changes, plus an appended history event — the customer's rating/title/body are
 *  never rewritten. The same controls apply to any rating, high or low. */
export async function moderateReview(id: string, action: 'hidden' | 'restored', reason: string) {
  const target = action === 'hidden' ? 'hidden' : 'published';
  const row = await prisma.review.findUnique({ where: { id }, select: { status: true } });
  if (!row) throw notFound('Review not found.');
  if (row.status === target) throw new HttpError(409, 'conflict', action === 'hidden' ? 'This review is already hidden.' : 'This review is already published.');

  await prisma.$transaction([
    prisma.review.update({ where: { id }, data: { status: target } }),
    prisma.reviewModerationEvent.create({ data: { reviewId: id, action, reason } }),
  ]);
  const updated = await prisma.review.findUniqueOrThrow({ where: { id }, include: ADMIN_INCLUDE });
  return toAdminReview(updated);
}
