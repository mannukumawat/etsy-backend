import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hermetic tests for the server-side product list (H16) and real duplicate (H17):
// Prisma is mocked, no database is touched.

const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'mysql://user:pass@localhost:3306/testdb';
  process.env.JWT_SECRET ??= 'test-only-jwt-secret-0123456789';
  const tx = {
    product: { create: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
    productImage: { deleteMany: vi.fn(), createMany: vi.fn() },
    productOption: { deleteMany: vi.fn(), create: vi.fn() },
    productOptionValue: { deleteMany: vi.fn() },
    productVariant: { deleteMany: vi.fn(), createMany: vi.fn(), findMany: vi.fn() },
    productSpec: { deleteMany: vi.fn(), createMany: vi.fn() },
    inventoryAdjustment: { createMany: vi.fn() },
  };
  return {
    tx,
    prisma: {
      product: { findMany: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn() },
      productVariant: { findMany: vi.fn() },
      storeSettings: { findUnique: vi.fn() },
      $queryRawUnsafe: vi.fn(),
      $transaction: vi.fn(),
    },
  };
});
vi.mock('../../../shared/database/prisma.js', () => ({ prisma: mocks.prisma, assertDatabaseReachable: vi.fn() }));

import { checkProductAvailability, duplicateProduct, listProducts } from '../product.service.js';
import { productRow } from './product.fixtures.js';

const { prisma } = mocks;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(mocks.tx));
  mocks.prisma.storeSettings.findUnique.mockResolvedValue({ lowStockThreshold: 5 });
  mocks.tx.productVariant.findMany.mockResolvedValue([]);
});

describe('listProducts (H16)', () => {
  it('paginates in the database and returns the page envelope (no 500 cap)', async () => {
    prisma.$queryRawUnsafe
      .mockResolvedValueOnce([{ total: 42 }])
      .mockResolvedValueOnce([{ id: 'p-test-mug' }]);
    prisma.product.findMany.mockResolvedValue([productRow()]);

    const result = await listProducts({ q: '', status: 'active', category: '', stock: '', flag: '', sort: 'updated', dir: 'desc', itemGroup: '', page: 2, pageSize: 20 });

    expect(result.total).toBe(42);
    expect(result.page).toBe(2);
    expect(result.pageSize).toBe(20);
    expect(result.pageCount).toBe(3);
    expect(result.items).toHaveLength(1);
    const countSql = String(prisma.$queryRawUnsafe.mock.calls[0][0]);
    expect(countSql).toContain('SELECT COUNT(*) as total FROM products');
    expect(countSql).toContain('status = ?');
    const pageSql = String(prisma.$queryRawUnsafe.mock.calls[1][0]);
    expect(pageSql).toContain('ORDER BY updatedAt DESC LIMIT ? OFFSET ?');
    expect(prisma.$queryRawUnsafe.mock.calls[1].slice(1)).toEqual(['active', 20, 20]);
  });

  it('filters by worst-variant stock using the live threshold', async () => {
    prisma.$queryRawUnsafe.mockResolvedValueOnce([{ total: 0 }]).mockResolvedValueOnce([]);
    prisma.product.findMany.mockResolvedValue([]);

    await listProducts({ q: '', status: '', category: '', stock: 'low', flag: '', sort: 'updated', dir: 'desc', itemGroup: '', page: 1, pageSize: 20 });

    const sql = String(prisma.$queryRawUnsafe.mock.calls[0][0]);
    expect(sql).toContain('v.stock > 0 AND v.stock <= ?');
    expect(prisma.$queryRawUnsafe.mock.calls[0].slice(1)).toEqual([5]);
  });

  it('searches with FULLTEXT for long queries (M7)', async () => {
    prisma.$queryRawUnsafe.mockResolvedValueOnce([{ total: 1 }]).mockResolvedValueOnce([{ id: 'p-test-mug' }]);
    prisma.product.findMany.mockResolvedValue([productRow()]);

    await listProducts({ q: 'kilim', status: '', category: '', stock: '', flag: '', sort: 'updated', dir: 'desc', itemGroup: '', page: 1, pageSize: 20 });

    const sql = String(prisma.$queryRawUnsafe.mock.calls[0][0]);
    expect(sql).toContain('MATCH(searchText) AGAINST(? IN BOOLEAN MODE)');
    expect(sql).not.toContain('LIKE');
    expect(prisma.$queryRawUnsafe.mock.calls[0].slice(1)).toEqual(['+kilim*']);
  });

  it('falls back to LIKE for short queries (M7)', async () => {
    prisma.$queryRawUnsafe.mockResolvedValueOnce([{ total: 1 }]).mockResolvedValueOnce([{ id: 'p-test-mug' }]);
    prisma.product.findMany.mockResolvedValue([productRow()]);

    await listProducts({ q: 'rug', status: '', category: '', stock: '', flag: '', sort: 'updated', dir: 'desc', itemGroup: '', page: 1, pageSize: 20 });

    const sql = String(prisma.$queryRawUnsafe.mock.calls[0][0]);
    expect(sql).toContain('searchText LIKE ?');
    expect(prisma.$queryRawUnsafe.mock.calls[0].slice(1)).toEqual(['%rug%']);
  });
});

describe('checkProductAvailability (H16)', () => {
  it('reports a slug clash and SKU clashes with the owning product name', async () => {
    prisma.product.findUnique.mockResolvedValue({ id: 'p-other', nameEn: 'Other Mug' });
    prisma.productVariant.findMany.mockResolvedValue([{ sku: 'MUG-RED', product: { nameEn: 'Other Mug' } }]);

    const result = await checkProductAvailability({ slug: 'mug', skus: ['MUG-RED', 'MUG-NEW'], excludeId: 'p-test-mug' });

    expect(result).toEqual({
      slugAvailable: false,
      slugUsedBy: 'Other Mug',
      skuClashes: [{ sku: 'MUG-RED', usedBy: 'Other Mug' }],
    });
  });

  it('treats the product being edited as available', async () => {
    prisma.product.findUnique.mockResolvedValue({ id: 'p-test-mug', nameEn: 'Test Mug' });
    prisma.productVariant.findMany.mockResolvedValue([]);

    const result = await checkProductAvailability({ slug: 'test-mug', skus: [], excludeId: 'p-test-mug' });

    expect(result.slugAvailable).toBe(true);
    expect(result.slugUsedBy).toBeNull();
  });
});

describe('duplicateProduct (H17)', () => {
  it('copies the product as a draft with zero stock, a -copy slug and fresh SKUs', async () => {
    prisma.product.findUnique.mockResolvedValue(productRow());
    prisma.product.findMany.mockResolvedValue([{ slug: 'test-mug' }]);
    prisma.productVariant.findMany.mockResolvedValue([{ sku: 'TEST-MUG-RED' }]);
    prisma.product.findUniqueOrThrow.mockResolvedValue(productRow());

    const copy = await duplicateProduct('p-test-mug');

    expect(copy.status).toBe('draft');
    // saveProduct creates the copy with the -copy slug and zero-stock variants.
    expect(mocks.tx.product.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ id: 'p-test-mug-copy', slug: 'test-mug-copy', status: 'draft', isFeatured: false }),
    });
    const variants = mocks.tx.productVariant.createMany.mock.calls[0][0].data as Array<{ sku: string; stock: number }>;
    expect(variants.every((v) => v.stock === 0)).toBe(true);
    expect(variants.map((v) => v.sku)).toEqual(['TEST-MUG-RED-COPY', 'TEST-MUG-BLUE-COPY']);
    expect(copy.id).toBe('p-test-mug');
  });

  it('answers 404 for an unknown product', async () => {
    prisma.product.findUnique.mockResolvedValue(null);
    await expect(duplicateProduct('p-missing')).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });
});
