import { prisma } from '../../shared/database/prisma.js';
import { emptyDistribution, EMPTY_REVIEW_SUMMARY, toPublicReview, type RatingDistribution, type ReviewSummary } from './review.mapper.js';

// Every public rating number (card stars, PDP average, count, distribution, review list) is computed
// live from the `reviews` table with ONE visibility rule: status = 'published'. Nothing is cached, so
// create/edit/delete/hide/restore are reflected immediately and can never drift apart.

export const PUBLISHED = { status: 'published' } as const;

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Average + count for many products in one grouped query (product lists, collections). */
export async function ratingSummaries(productIds: string[]): Promise<Map<string, ReviewSummary>> {
  const map = new Map<string, ReviewSummary>();
  if (!productIds.length) return map;
  const groups = await prisma.review.groupBy({
    by: ['productId'],
    where: { ...PUBLISHED, productId: { in: productIds } },
    _avg: { rating: true },
    _count: { _all: true },
  });
  for (const g of groups) {
    map.set(g.productId, { ...EMPTY_REVIEW_SUMMARY, rating: round1(g._avg.rating ?? 0), reviewCount: g._count._all, distribution: emptyDistribution() });
  }
  return map;
}

export async function ratingDistribution(productId: string): Promise<RatingDistribution> {
  const groups = await prisma.review.groupBy({ by: ['rating'], where: { ...PUBLISHED, productId }, _count: { _all: true } });
  const dist = emptyDistribution();
  for (const g of groups) {
    const key = String(g.rating) as keyof RatingDistribution;
    if (key in dist) dist[key] = g._count._all;
  }
  return dist;
}

/** Full summary for one product: average, count, distribution and the newest few reviews. */
export async function productReviewSummary(productId: string, recentCount = 3): Promise<ReviewSummary> {
  const [agg, distribution, recent] = await Promise.all([
    prisma.review.aggregate({ where: { ...PUBLISHED, productId }, _avg: { rating: true }, _count: { _all: true } }),
    ratingDistribution(productId),
    prisma.review.findMany({
      where: { ...PUBLISHED, productId },
      orderBy: { createdAt: 'desc' },
      take: recentCount,
      include: { customer: { select: { name: true } } },
    }),
  ]);
  return { rating: round1(agg._avg.rating ?? 0), reviewCount: agg._count._all, distribution, recent: recent.map(toPublicReview) };
}
