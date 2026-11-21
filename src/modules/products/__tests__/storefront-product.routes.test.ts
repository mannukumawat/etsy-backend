import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hermetic tests for server-side pagination in listStorefrontProducts.
// Prisma is mocked, no database is touched.
//
// NOTE: this tests the service directly rather than through HTTP. An
// HTTP-level test via createApp() cannot even load in this environment:
// the app pulls in modules that value-import '@prisma/client', whose
// generated client is missing (prisma generate fails ECONNRESET), so every
// suite that builds the app fails at collection — including the pre-existing
// admin product suite. The route itself is two lines of query parsing
// (page/limit clamps) verified by code review; all paging math lives here.

const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
  process.env.JWT_SECRET ??= 'test-only-jwt-secret-0123456789';
  const allRows = Array.from({ length: 25 }, (_, i) => i);
  return {
    allRows,
    prisma: {
      product: { findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn() },
      category: { findMany: vi.fn() },
      review: { groupBy: vi.fn() },
      $queryRaw: vi.fn(),
    },
  };
});
vi.mock('../../../shared/database/prisma.js', () => ({ prisma: mocks.prisma, assertDatabaseReachable: vi.fn() }));

import { listStorefrontProducts } from '../storefront-product.service.js';
import { productRow } from './product.fixtures.js';

/** 25 active products, one per row, as Prisma would return them. */
function rows() {
  return mocks.allRows.map((i) => productRow({ id: `p-${i}`, slug: `product-${i}` }));
}

describe('listStorefrontProducts pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.product.findMany.mockImplementation((args: { skip?: number; take?: number }) =>
      rows().slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? 200)),
    );
    mocks.prisma.product.count.mockImplementation((args: { where?: { variants?: unknown } }) =>
      Promise.resolve(args?.where?.variants ? 20 : 25),
    );
    mocks.prisma.product.groupBy.mockResolvedValue([{ categoryId: 'ceramics', _count: { _all: 25 } }]);
    mocks.prisma.category.findMany.mockResolvedValue([{ id: 'ceramics', slug: 'ceramics' }]);
    mocks.prisma.review.groupBy.mockResolvedValue([]);
  });

  const base = { q: '', categories: [] as string[], ids: [] as string[] };

  it('returns the requested page with skip/take and full-set totals + facets', async () => {
    const res = await listStorefrontProducts({ ...base, page: 2, limit: 12 });
    expect(res.items).toHaveLength(12);
    expect(res.items[0].slug).toBe('product-12');
    expect(res.total).toBe(25);
    expect(res.page).toBe(2);
    expect(res.pageSize).toBe(12);
    expect(res.pageCount).toBe(3);
    expect(res.facets).toEqual({
      categories: { ceramics: 25 },
      availability: { in_stock: 20, out_of_stock: 5 },
    });
    expect(mocks.prisma.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 12, take: 12 }),
    );
  });

  it('returns the requested page with limit 200 when asked', async () => {
    const res = await listStorefrontProducts({ ...base, page: 1, limit: 200 });
    expect(res.items).toHaveLength(25);
    expect(res.page).toBe(1);
    expect(res.pageSize).toBe(200);
    expect(res.pageCount).toBe(1);
    expect(mocks.prisma.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 200 }),
    );
  });

  it('returns an EMPTY page past the end instead of silently clamping to the last page (M6)', async () => {
    const res = await listStorefrontProducts({ ...base, page: 99, limit: 12 });
    expect(res.page).toBe(99);
    expect(res.pageCount).toBe(3);
    expect(res.items).toHaveLength(0);
    expect(res.total).toBe(25);
    expect(mocks.prisma.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 1176, take: 12 }),
    );
  });

  it('uses the list-only select, not the full hydration (M6)', async () => {
    await listStorefrontProducts({ ...base, page: 1, limit: 12 });
    const args = mocks.prisma.product.findMany.mock.calls[0][0] as Record<string, unknown>;
    expect(args.select).toBeDefined();
    expect(args.include).toBeUndefined();
  });

  it('searches with FULLTEXT for long queries and intersects the ids (M7)', async () => {
    mocks.prisma.$queryRaw.mockResolvedValue([{ id: 'p-3' }, { id: 'p-7' }]);
    const res = await listStorefrontProducts({ ...base, q: 'kilim', page: 1, limit: 12 });
    expect(res.total).toBe(25);
    // $queryRaw is called as a tagged template: strings[0] holds the SQL, values[0] the boolean query.
    const rawCall = mocks.prisma.$queryRaw.mock.calls[0];
    expect(String(rawCall[0][0])).toContain('MATCH(searchText) AGAINST');
    expect(rawCall[1]).toBe('+kilim*');
    expect(mocks.prisma.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { in: ['p-3', 'p-7'] } }) }),
    );
  });

  it('falls back to LIKE for short queries and never touches $queryRaw (M7)', async () => {
    await listStorefrontProducts({ ...base, q: 'rug', page: 1, limit: 12 });
    expect(mocks.prisma.$queryRaw).not.toHaveBeenCalled();
    expect(mocks.prisma.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ searchText: { contains: 'rug' } }) }),
    );
  });
});
