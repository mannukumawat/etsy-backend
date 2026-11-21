import * as XLSX from 'xlsx';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hermetic tests for the product Excel export (H6) including the round-trip back
// through the fixed import (C2–C4): Prisma is mocked, no database is touched.

const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'mysql://user:pass@localhost:3306/testdb';
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
      media: { findMany: vi.fn() },
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
    },
  };
});
vi.mock('../../../shared/database/prisma.js', () => ({ prisma: mocks.prisma, assertDatabaseReachable: vi.fn() }));

import { exportProductsWorkbook } from '../export.service.js';
import { importProductsFromWorkbook } from '../import.service.js';

const { prisma, tx } = mocks;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx));
});

/** One product with TWO options (Colour + Size) and two variants, stored in USD minor units. */
function exportedProduct() {
  return {
    slug: 'kilim-rug',
    status: 'active',
    nameEn: 'Kilim Rug',
    descriptionEn: 'Handwoven rug.',
    tags: JSON.stringify(['kilim', 'wool']),
    basePrice: 15739,
    baseSalePrice: 4407,
    materialsEn: 'Wool',
    careEn: 'Dry clean only.',
    seoTitleEn: 'Kilim Rug',
    seoDescriptionEn: 'A kilim rug.',
    isFeatured: true,
    isBestseller: false,
    isNew: true,
    weightValue: 500,
    weightUnit: 'g',
    dimLength: 120,
    dimWidth: 80,
    dimHeight: null,
    displayOrder: 10,
    returnsAllowed: true,
    exchangeAllowed: true,
    returnDays: 30,
    category: { nameEn: 'Kilim Rug' },
    itemGroup: { nameEn: 'Rugs' },
    navLink: { labelEn: 'Shop rugs' },
    options: [
      {
        id: 'opt-color',
        nameEn: 'Colour',
        values: [
          { id: 'val-red', labelEn: 'Red', position: 0 },
          { id: 'val-blue', labelEn: 'Blue', position: 1 },
        ],
        position: 0,
      },
      {
        id: 'opt-size',
        nameEn: 'Size',
        values: [
          { id: 'val-2x3', labelEn: '2x3 Ft', position: 0 },
          { id: 'val-4x6', labelEn: '4x6 Ft', position: 1 },
        ],
        position: 1,
      },
    ],
    variants: [
      { sku: 'RUG-RED-2X3', options: JSON.stringify({ 'opt-color': 'val-red', 'opt-size': 'val-2x3' }), price: 4407, stock: 3, position: 0 },
      { sku: 'RUG-BLUE-4X6', options: JSON.stringify({ 'opt-color': 'val-blue', 'opt-size': 'val-4x6' }), price: 16353, stock: 2, position: 1 },
    ],
    images: [{ mediaId: 'm_rug' }],
    specs: [{ labelEn: 'Weave', valueEn: 'Flatweave', position: 0 }],
  };
}

function readProductsSheet(buf: Buffer): Array<Record<string, unknown>> {
  const wb = XLSX.read(buf, { type: 'buffer' });
  return XLSX.utils.sheet_to_json(wb.Sheets['Products']);
}

describe('exportProductsWorkbook (H6)', () => {
  it('exports every option (not just Size), the SKU/slug/status and the reference columns', async () => {
    prisma.currencyConfig.findFirst.mockResolvedValue({ rate: 100, fractionDigits: 2, roundingIncrement: 1 });
    prisma.product.findMany.mockResolvedValue([exportedProduct()]);
    prisma.media.findMany.mockResolvedValue([{ id: 'm_rug', cloudinaryUrl: 'https://cdn.example/rug.jpg' }]);

    const rows = readProductsSheet(await exportProductsWorkbook());

    expect(rows).toHaveLength(2);
    // The Colour option survives (the old export dropped everything but Size).
    expect(rows[0].options).toBe('Colour: Red; Size: 2x3 Ft');
    expect(rows[1].options).toBe('Colour: Blue; Size: 4x6 Ft');
    expect(rows[0]).toMatchObject({ slug: 'kilim-rug', sku: 'RUG-RED-2X3', status: 'active', stock: 3 });
    expect(rows[0].images).toBe('https://cdn.example/rug.jpg');
    expect(rows[0]).toMatchObject({
      tags: 'kilim, wool',
      seo_title: 'Kilim Rug',
      materials: 'Wool',
      care: 'Dry clean only.',
      specs: 'Weave: Flatweave',
      is_featured: 'yes',
      is_new: 'yes',
      weight_g: 500,
      display_order: 10,
      item_group: 'Rugs',
      nav_link: 'Shop rugs',
      returns_allowed: 'yes',
      return_days: 30,
    });
    // Core import columns keep the INR prices (USD $157.39 → ₹15,739 at rate 100).
    expect(rows[0]).toMatchObject({ mrp_inr: 15739, sale_inr: 4407, size_label: '2x3 Ft', size_price_inr: 4407 });
    expect(rows[1]).toMatchObject({ size_label: '4x6 Ft', size_price_inr: 16353 });
  });

  it('round-trips: the exported file re-imports to the same product, prices and stock', async () => {
    prisma.currencyConfig.findFirst.mockResolvedValue({ rate: 100, fractionDigits: 2, roundingIncrement: 1 });
    prisma.product.findMany.mockResolvedValue([exportedProduct()]);
    prisma.media.findMany.mockResolvedValue([]);

    const buf = await exportProductsWorkbook();

    // Re-import as a fresh catalogue: no existing products or categories.
    prisma.category.findMany.mockResolvedValue([]);
    prisma.product.findMany.mockResolvedValue([]);
    prisma.product.count.mockResolvedValue(0);

    const result = await importProductsFromWorkbook(buf);

    expect(result).toMatchObject({ imported: 1, updated: 0, skipped: 0, errors: [] });
    expect(result.variants).toBe(2);
    const created = tx.product.createMany.mock.calls[0][0].data as Array<Record<string, unknown>>;
    expect(created[0].basePrice).toBe(15739); // ₹15,739 → $157.39, not $15,739
    expect(created[0].baseSalePrice).toBe(4407);
    expect(created[0].status).toBe('draft');
    const variants = tx.productVariant.createMany.mock.calls[0][0].data as Array<Record<string, unknown>>;
    expect(variants.map((v) => v.price)).toEqual([4407, 16353]);
    expect(variants.map((v) => v.stock)).toEqual([3, 2]);
  });
});
