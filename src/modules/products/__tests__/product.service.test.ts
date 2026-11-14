import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hermetic tests for the product write path, focused on the option / value / variant id remapping:
// Prisma is mocked, no database is touched.

const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
  process.env.JWT_SECRET ??= 'test-only-jwt-secret-0123456789';
  const tx = {
    product: { create: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
    productImage: { deleteMany: vi.fn(), createMany: vi.fn() },
    productOption: { deleteMany: vi.fn(), create: vi.fn() },
    productOptionValue: { deleteMany: vi.fn() },
    productVariant: { deleteMany: vi.fn(), createMany: vi.fn() },
    productSpec: { deleteMany: vi.fn(), createMany: vi.fn() },
  };
  return {
    tx,
    prisma: {
      product: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn() },
      category: { findUnique: vi.fn() },
      productVariant: { findMany: vi.fn() },
      media: { findMany: vi.fn() },
      $transaction: vi.fn(),
    },
  };
});
vi.mock('../../../shared/database/prisma.js', () => ({ prisma: mocks.prisma, assertDatabaseReachable: vi.fn() }));

import { productInputSchema } from '../product.schema.js';
import { createProduct, updateProduct } from '../product.service.js';
import { productRow } from './product.fixtures.js';

const parse = (raw: Record<string, unknown>) => productInputSchema.parse(raw);

const colorOption = (optionId: string, redId: string, blueId: string) => ({
  id: optionId,
  name: { en: 'Color' },
  type: 'swatch',
  values: [
    { id: redId, label: { en: 'Red' }, swatch: '#C04A17' },
    { id: blueId, label: { en: 'Blue' }, swatch: '#1F4E79' },
  ],
});

describe('product write path: id remapping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(mocks.tx));
    mocks.prisma.category.findUnique.mockResolvedValue({ id: 'ceramics', isActive: true });
    mocks.prisma.productVariant.findMany.mockResolvedValue([]);
    mocks.prisma.product.findUniqueOrThrow.mockResolvedValue(productRow());
  });

  it('prefixes new option, value, variant and spec ids with the product id', async () => {
    await createProduct(
      parse({
        slug: 'mug',
        name: { en: 'Mug' },
        shortDescription: { en: '' },
        description: { en: '' },
        materials: { en: '' },
        care: { en: '' },
        categoryId: 'ceramics',
        basePrice: 1500,
        options: [colorOption('color', 'red', 'blue')],
        variants: [
          { id: 'v-red', sku: 'MUG-RED', options: { color: 'red' }, price: 1500, stock: 1 },
          { id: 'v-blue', sku: 'MUG-BLUE', options: { color: 'blue' }, price: 1500, stock: 2 },
        ],
        specs: [{ id: 's1', label: { en: 'Capacity' }, value: { en: '350 ml' } }],
      }),
    );

    expect(mocks.tx.productOption.create).toHaveBeenCalledTimes(1);
    expect(mocks.tx.productOption.create).toHaveBeenCalledWith({
      data: {
        id: 'p-mug__color',
        productId: 'p-mug',
        nameEn: 'Color',
        nameHi: '',
        type: 'swatch',
        position: 0,
        values: {
          create: [
            { id: 'p-mug__color__red', labelEn: 'Red', labelHi: '', swatch: '#C04A17', position: 0 },
            { id: 'p-mug__color__blue', labelEn: 'Blue', labelHi: '', swatch: '#1F4E79', position: 1 },
          ],
        },
      },
    });
    // A variant's option map must hold the SAME final ids that were just written for the option values.
    expect(mocks.tx.productVariant.createMany).toHaveBeenCalledWith({
      data: [
        { id: 'p-mug--v-red', productId: 'p-mug', sku: 'MUG-RED', options: JSON.stringify({ 'p-mug__color': 'p-mug__color__red' }), price: 1500, salePrice: null, stock: 1, imageIds: '[]', position: 0 },
        { id: 'p-mug--v-blue', productId: 'p-mug', sku: 'MUG-BLUE', options: JSON.stringify({ 'p-mug__color': 'p-mug__color__blue' }), price: 1500, salePrice: null, stock: 2, imageIds: '[]', position: 1 },
      ],
    });
    expect(mocks.tx.productSpec.createMany).toHaveBeenCalledWith({
      data: [{ id: 'p-mug__spec__s1', productId: 'p-mug', labelEn: 'Capacity', labelHi: '', valueEn: '350 ml', valueHi: '', position: 0 }],
    });
  });

  it('does not add another prefix layer when the editor sends already-prefixed ids back (save round trip)', async () => {
    mocks.prisma.product.findUnique.mockResolvedValue({ id: 'p-mug' });

    await updateProduct(
      'p-mug',
      parse({
        slug: 'mug',
        name: { en: 'Mug' },
        shortDescription: { en: '' },
        description: { en: '' },
        materials: { en: '' },
        care: { en: '' },
        categoryId: 'ceramics',
        basePrice: 1500,
        options: [colorOption('p-mug__color', 'p-mug__color__red', 'p-mug__color__blue')],
        variants: [
          { id: 'p-mug--v-red', sku: 'MUG-RED', options: { 'p-mug__color': 'p-mug__color__red' }, price: 1500, stock: 1 },
          { id: 'p-mug--v-blue', sku: 'MUG-BLUE', options: { 'p-mug__color': 'p-mug__color__blue' }, price: 1500, stock: 2 },
        ],
      }),
    );

    const option = mocks.tx.productOption.create.mock.calls[0][0].data;
    expect(option.id).toBe('p-mug__color');
    expect(option.values.create.map((v: { id: string }) => v.id)).toEqual(['p-mug__color__red', 'p-mug__color__blue']);
    const variants = mocks.tx.productVariant.createMany.mock.calls[0][0].data;
    expect(variants.map((v: { id: string }) => v.id)).toEqual(['p-mug--v-red', 'p-mug--v-blue']);
    expect(variants.map((v: { options: string }) => JSON.parse(v.options))).toEqual([
      { 'p-mug__color': 'p-mug__color__red' },
      { 'p-mug__color': 'p-mug__color__blue' },
    ]);
  });

  it('prefixes only the new option when a prefixed one and a raw one are mixed', async () => {
    mocks.prisma.product.findUnique.mockResolvedValue({ id: 'p-mug' });

    await updateProduct(
      'p-mug',
      parse({
        slug: 'mug',
        name: { en: 'Mug' },
        shortDescription: { en: '' },
        description: { en: '' },
        materials: { en: '' },
        care: { en: '' },
        categoryId: 'ceramics',
        basePrice: 1500,
        options: [
          { id: 'p-mug__color', name: { en: 'Color' }, type: 'button', values: [{ id: 'p-mug__color__red', label: { en: 'Red' } }] },
          { id: 'size', name: { en: 'Size' }, type: 'button', values: [{ id: 'sm', label: { en: 'Small' } }] },
        ],
        variants: [{ id: 'v1', sku: 'MUG-RED-SM', options: { 'p-mug__color': 'p-mug__color__red', size: 'sm' }, price: 1500, stock: 1 }],
      }),
    );

    expect(mocks.tx.productOption.create.mock.calls.map((c) => c[0].data.id)).toEqual(['p-mug__color', 'p-mug__size']);
    expect(mocks.tx.productOption.create.mock.calls[1][0].data.values.create[0].id).toBe('p-mug__size__sm');
    const [variant] = mocks.tx.productVariant.createMany.mock.calls[0][0].data;
    expect(variant.id).toBe('p-mug--v1');
    expect(JSON.parse(variant.options)).toEqual({ 'p-mug__color': 'p-mug__color__red', 'p-mug__size': 'p-mug__size__sm' });
  });

  it('keeps ids unique across products: the same raw option id gets each product its own prefix', async () => {
    const body = (slug: string) =>
      parse({
        slug,
        name: { en: slug },
        shortDescription: { en: '' },
        description: { en: '' },
        materials: { en: '' },
        care: { en: '' },
        categoryId: 'ceramics',
        basePrice: 1500,
        options: [colorOption('color', 'red', 'blue')],
        variants: [
          { id: 'v-red', sku: `${slug}-red`.toUpperCase(), options: { color: 'red' }, price: 1500, stock: 1 },
          { id: 'v-blue', sku: `${slug}-blue`.toUpperCase(), options: { color: 'blue' }, price: 1500, stock: 1 },
        ],
      });

    await createProduct(body('mug'));
    await createProduct(body('bowl'));

    expect(mocks.tx.productOption.create.mock.calls.map((c) => c[0].data.id)).toEqual(['p-mug__color', 'p-bowl__color']);
  });
});

describe('product write path: transaction shape', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(mocks.tx));
    mocks.prisma.category.findUnique.mockResolvedValue({ id: 'ceramics', isActive: true });
    mocks.prisma.productVariant.findMany.mockResolvedValue([]);
    mocks.prisma.product.findUniqueOrThrow.mockResolvedValue(productRow());
  });

  const body = () => parse({ slug: 'mug', name: { en: 'Mug' }, shortDescription: { en: '' }, description: { en: '' }, materials: { en: '' }, care: { en: '' }, categoryId: 'ceramics', basePrice: 1500, variants: [{ id: 'v1', sku: 'MUG-1', price: 1500, stock: 1 }] });

  it('update: rewrites the product row, clears all children, then recreates them — all inside one transaction', async () => {
    mocks.prisma.product.findUnique.mockResolvedValue({ id: 'p-mug' });

    await updateProduct('p-mug', body());

    expect(mocks.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { maxWait: 10_000, timeout: 30_000 });
    expect(mocks.tx.product.create).not.toHaveBeenCalled();
    const order = (fn: { mock: { invocationCallOrder: number[] } }) => fn.mock.invocationCallOrder[0];
    const clears = [mocks.tx.productImage.deleteMany, mocks.tx.productOption.deleteMany, mocks.tx.productVariant.deleteMany, mocks.tx.productSpec.deleteMany].map(order);
    expect(order(mocks.tx.product.update)).toBeLessThan(Math.min(...clears));
    expect(Math.max(...clears)).toBeLessThan(order(mocks.tx.productVariant.createMany));
  });

  it('update: answers 404 for an unknown product without opening a transaction', async () => {
    mocks.prisma.product.findUnique.mockResolvedValue(null);

    await expect(updateProduct('p-missing', body())).rejects.toMatchObject({ status: 404, code: 'not_found', message: 'Product not found.' });
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('create: a failing child write aborts the whole save (nothing is returned or re-read)', async () => {
    mocks.tx.productVariant.createMany.mockRejectedValue(new Error('variant insert failed'));

    await expect(createProduct(body())).rejects.toThrow('variant insert failed');
    expect(mocks.prisma.product.findUniqueOrThrow).not.toHaveBeenCalled();
  });
});
