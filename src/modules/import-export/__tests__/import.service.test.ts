import * as XLSX from 'xlsx';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hermetic tests for the product Excel import (C2–C4): Prisma is mocked, no database
// is touched, no Razorpay/mail calls happen.

const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
  process.env.JWT_SECRET ??= 'test-only-jwt-secret-0123456789';
  const tx = {
    category: { upsert: vi.fn() },
    product: { update: vi.fn(), createMany: vi.fn() },
    productOption: { deleteMany: vi.fn(), createMany: vi.fn() },
    productOptionValue: { deleteMany: vi.fn(), createMany: vi.fn() },
    productVariant: { deleteMany: vi.fn(), createMany: vi.fn() },
  };
  return {
    tx,
    prisma: {
      currencyConfig: { findFirst: vi.fn() },
      category: { findMany: vi.fn() },
      product: { findMany: vi.fn(), count: vi.fn() },
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
    },
  };
});
vi.mock('../../../shared/database/prisma.js', () => ({ prisma: mocks.prisma, assertDatabaseReachable: vi.fn() }));

import { importProductsFromWorkbook } from '../import.service.js';

const { prisma, tx } = mocks;

function workbook(rows: Record<string, unknown>[]): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Products');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

const rugRows = [
  { product_name: 'Natural Wool Kilim Rug', category: 'Kilim Rug', description: 'Handwoven rug.', mrp_inr: 15739, sale_inr: 4407, stock: 3, size_label: '2x3 Ft Kilim Rug (₹ 4,407)', size_price_inr: 4407 },
  { product_name: 'Natural Wool Kilim Rug', category: 'Kilim Rug', description: 'Handwoven rug.', mrp_inr: 15739, sale_inr: 4407, stock: 2, size_label: '4x6 Ft Kilim Rug (₹ 16,353)', size_price_inr: 16353 },
];

function mockEmptyCatalog(rate = 100) {
  prisma.currencyConfig.findFirst.mockResolvedValue({ rate });
  prisma.category.findMany.mockResolvedValue([]);
  prisma.product.findMany.mockResolvedValue([]);
  prisma.product.count.mockResolvedValue(0);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx));
});

describe('importProductsFromWorkbook (C2–C4)', () => {
  it('converts ₹15,739 to $157.39 (15739 USD cents) at rate 100 and creates a draft', async () => {
    mockEmptyCatalog(100);
    const result = await importProductsFromWorkbook(workbook(rugRows));

    expect(result).toMatchObject({ imported: 1, updated: 0, skipped: 0, errors: [] });
    expect(result.variants).toBe(2);
    const created = tx.product.createMany.mock.calls[0][0].data as Array<Record<string, unknown>>;
    expect(created).toHaveLength(1);
    expect(created[0].basePrice).toBe(15739); // $157.39 — not $15,739
    expect(created[0].baseSalePrice).toBe(4407);
    expect(created[0].status).toBe('draft');
    const variants = tx.productVariant.createMany.mock.calls[0][0].data as Array<Record<string, unknown>>;
    expect(variants.map((v) => v.price)).toEqual([4407, 16353]);
    expect(variants.map((v) => v.stock)).toEqual([3, 2]);
  });

  it('converts at the live rate: ₹15,739 at rate 84 is $187.37', async () => {
    mockEmptyCatalog(84);
    await importProductsFromWorkbook(workbook(rugRows));
    const created = tx.product.createMany.mock.calls[0][0].data as Array<Record<string, unknown>>;
    expect(created[0].basePrice).toBe(18737);
  });

  it('refuses the import when no INR rate is configured', async () => {
    prisma.currencyConfig.findFirst.mockResolvedValue(null);
    prisma.category.findMany.mockResolvedValue([]);
    prisma.product.findMany.mockResolvedValue([]);
    await expect(importProductsFromWorkbook(workbook(rugRows))).rejects.toThrow('INR currency rate');
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('reports per-row errors and still imports the valid products (C4)', async () => {
    mockEmptyCatalog(100);
    const rows = [
      ...rugRows,
      { product_name: '', category: 'Kilim Rug', description: '', mrp_inr: 1000, sale_inr: '', stock: 1, size_label: '', size_price_inr: '' },
      { product_name: 'Bad MRP Rug', category: 'Kilim Rug', description: '', mrp_inr: 0, sale_inr: '', stock: 1, size_label: '', size_price_inr: '' },
      { product_name: 'Bad Sale Rug', category: 'Kilim Rug', description: '', mrp_inr: 1000, sale_inr: 1500, stock: 1, size_label: '', size_price_inr: '' },
      { product_name: 'Bad Stock Rug', category: 'Kilim Rug', description: '', mrp_inr: 1000, sale_inr: '', stock: 'abc', size_label: '', size_price_inr: '' },
    ];
    const result = await importProductsFromWorkbook(workbook(rows));

    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(3);
    expect(result.errors.map((e) => `${e.row}:${e.field}`)).toEqual([
      '4:product_name',
      '5:mrp_inr',
      '6:sale_inr',
      '7:stock',
    ]);
    const created = tx.product.createMany.mock.calls[0][0].data as Array<Record<string, unknown>>;
    expect(created).toHaveLength(1);
  });

  it('groups "Rug" and "rug" rows into one product (C4)', async () => {
    mockEmptyCatalog(100);
    const rows = [
      { product_name: 'Kilim Rug', category: 'Kilim Rug', description: 'd', mrp_inr: 1000, sale_inr: '', stock: 1, size_label: 'Small', size_price_inr: 1000 },
      { product_name: 'kilim  rug', category: 'Kilim Rug', description: 'd', mrp_inr: 1000, sale_inr: '', stock: 1, size_label: 'Large', size_price_inr: 1200 },
    ];
    const result = await importProductsFromWorkbook(workbook(rows));
    expect(result.imported).toBe(1);
    expect(result.variants).toBe(2);
  });

  it('re-importing the same slug UPDATES the existing product instead of duplicating it (C3)', async () => {
    mockEmptyCatalog(100);
    prisma.product.findMany.mockResolvedValue([{ id: 'pi-existing', slug: 'natural-wool-kilim-rug', status: 'active' }]);
    const result = await importProductsFromWorkbook(workbook(rugRows));

    expect(result).toMatchObject({ imported: 0, updated: 1, skipped: 0 });
    expect(tx.product.createMany).not.toHaveBeenCalled();
    expect(tx.product.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'pi-existing' } }),
    );
    // Old options/variants are rebuilt; the product keeps its status and images.
    expect(tx.productVariant.deleteMany).toHaveBeenCalledWith({ where: { productId: 'pi-existing' } });
    const updateData = tx.product.update.mock.calls[0][0].data as Record<string, unknown>;
    expect(updateData).not.toHaveProperty('status');
    expect(updateData.basePrice).toBe(15739);
  });

  it('rejects an inactive category instead of silently skipping the product (C3/C4)', async () => {
    mockEmptyCatalog(100);
    prisma.category.findMany.mockResolvedValue([{ id: 'c1', slug: 'kilim-rug', nameEn: 'Kilim Rug', isActive: false }]);
    const result = await importProductsFromWorkbook(workbook(rugRows));
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.errors[0]).toMatchObject({ field: 'category' });
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('runs every write inside one transaction (C4)', async () => {
    mockEmptyCatalog(100);
    await importProductsFromWorkbook(workbook(rugRows));
    expect(mocks.prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});
