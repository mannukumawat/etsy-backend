import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Hermetic regression tests for /api/admin/products: Prisma is mocked, no database is touched.

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
      owner: { findUnique: vi.fn() },
      product: { findMany: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn() },
      category: { findUnique: vi.fn() },
      productVariant: { findMany: vi.fn() },
      media: { findMany: vi.fn() },
      $transaction: vi.fn(),
    },
  };
});
vi.mock('../../../shared/database/prisma.js', () => ({ prisma: mocks.prisma, assertDatabaseReachable: vi.fn() }));

import { createApp } from '../../../app.js';
import { CSRF_FORBIDDEN_BODY, UNAUTHORIZED_BODY, findOwner, loginAsOwner, type Session } from '../../../__tests__/support/owner-session.js';
import { PRODUCT_INCLUDE } from '../product.mapper.js';
import { productRow, validProductBody } from './product.fixtures.js';

const app = createApp();

const NOT_FOUND = { error: { code: 'not_found', message: 'Product not found.', issues: [] } };

/** Body of a complete, publishable (status: active) product. */
const activeBody = () =>
  validProductBody({
    status: 'active',
    shortDescription: { en: 'A sturdy mug' },
    description: { en: 'A very nice, sturdy mug.' },
    images: [{ mediaId: 'm_1', alt: { en: 'A mug' } }],
  });

describe('admin products (/api/admin/products)', () => {
  let session: Session;
  const write = (req: request.Test) => req.set('Cookie', session.cookie).set('x-csrf-token', session.csrf);

  beforeAll(async () => {
    mocks.prisma.owner.findUnique.mockImplementation(findOwner);
    session = await loginAsOwner(app);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.owner.findUnique.mockImplementation(findOwner);
    mocks.prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(mocks.tx));
    mocks.prisma.category.findUnique.mockResolvedValue({ id: 'ceramics', isActive: true });
    mocks.prisma.productVariant.findMany.mockResolvedValue([]);
    mocks.prisma.media.findMany.mockResolvedValue([{ id: 'm_1' }]);
  });

  describe('authorization', () => {
    const endpoints: Array<[string, string, () => request.Test]> = [
      ['GET', '/', () => request(app).get('/api/admin/products')],
      ['GET', '/:id', () => request(app).get('/api/admin/products/p-test-mug')],
      ['POST', '/', () => request(app).post('/api/admin/products').send(validProductBody())],
      ['PUT', '/:id', () => request(app).put('/api/admin/products/p-test-mug').send(validProductBody())],
      ['PATCH', '/:id/status', () => request(app).patch('/api/admin/products/p-test-mug/status').send({ status: 'archived' })],
      ['DELETE', '/all', () => request(app).delete('/api/admin/products/all')],
    ];

    it.each(endpoints)('rejects anonymous %s %s before touching the database', async (_method, _path, send) => {
      const res = await send();
      expect(res.status).toBe(401);
      expect(res.body).toEqual(UNAUTHORIZED_BODY);
      for (const fn of [mocks.prisma.product.findMany, mocks.prisma.product.findUnique, mocks.prisma.product.update, mocks.prisma.$transaction]) {
        expect(fn).not.toHaveBeenCalled();
      }
    });

    it('rejects every signed-in write that lacks the csrf header', async () => {
      const writes = [
        request(app).post('/api/admin/products').send(validProductBody()),
        request(app).put('/api/admin/products/p-test-mug').send(validProductBody()),
        request(app).patch('/api/admin/products/p-test-mug/status').send({ status: 'archived' }),
        request(app).delete('/api/admin/products/all'),
      ];
      for (const req of writes) {
        const res = await req.set('Cookie', session.cookie);
        expect(res.status).toBe(403);
        expect(res.body).toEqual(CSRF_FORBIDDEN_BODY);
      }
      expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
      expect(mocks.prisma.product.update).not.toHaveBeenCalled();
    });

    it('keeps unknown /api/admin paths behind the owner gate (401 anonymous, 404 signed in)', async () => {
      const anonymous = await request(app).get('/api/admin/does-not-exist');
      expect(anonymous.status).toBe(401);
      expect(anonymous.body).toEqual(UNAUTHORIZED_BODY);

      const signedIn = await request(app).get('/api/admin/does-not-exist').set('Cookie', session.cookie);
      expect(signedIn.status).toBe(404);
      expect(signedIn.body).toEqual({ error: { code: 'not_found', message: 'No such endpoint.', issues: [] } });
    });
  });

  describe('GET /', () => {
    it('lists products newest-updated first, applying the status / search / item-group filters', async () => {
      mocks.prisma.product.findMany.mockResolvedValue([productRow()]);

      const res = await request(app).get('/api/admin/products?q=%20Mug%20&status=active&itemGroup=pots').set('Cookie', session.cookie);

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
      expect(res.body.items).toHaveLength(1);
      expect(mocks.prisma.product.findMany).toHaveBeenCalledWith({
        where: { status: 'active', searchText: { contains: 'mug' }, itemGroup: { slug: 'pots' } },
        include: PRODUCT_INCLUDE,
        orderBy: { updatedAt: 'desc' },
        take: 500,
      });
    });

    it('ignores an unknown status filter and an empty query', async () => {
      mocks.prisma.product.findMany.mockResolvedValue([]);

      const res = await request(app).get('/api/admin/products?status=bogus').set('Cookie', session.cookie);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ items: [], total: 0 });
      expect(mocks.prisma.product.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {} }));
    });

    it('returns the admin product shape', async () => {
      mocks.prisma.product.findMany.mockResolvedValue([productRow()]);

      const res = await request(app).get('/api/admin/products').set('Cookie', session.cookie);

      expect(Object.keys(res.body.items[0]).sort()).toEqual(
        [
          'id', 'slug', 'status', 'name', 'shortDescription', 'description', 'categoryId', 'itemGroupId', 'navLinkId', 'tags',
          'basePrice', 'baseSalePrice', 'images', 'options', 'variants', 'weight', 'dimensions', 'specs', 'materials', 'care',
          'returnsAllowed', 'exchangeAllowed', 'returnDays', 'isFeatured', 'isBestseller', 'isNew', 'displayOrder', 'seo',
          'createdAt', 'updatedAt',
        ].sort(),
      );
    });
  });

  describe('GET /:id', () => {
    it('returns one product with media ids, option/value ids and variant option maps', async () => {
      mocks.prisma.product.findUnique.mockResolvedValue(productRow());

      const res = await request(app).get('/api/admin/products/p-test-mug').set('Cookie', session.cookie);

      expect(res.status).toBe(200);
      expect(mocks.prisma.product.findUnique).toHaveBeenCalledWith({ where: { id: 'p-test-mug' }, include: PRODUCT_INCLUDE });
      expect(res.body).toMatchObject({
        id: 'p-test-mug',
        slug: 'test-mug',
        status: 'draft',
        name: { en: 'Test Mug' },
        categoryId: 'ceramics',
        tags: ['mug'],
        basePrice: 1500,
        baseSalePrice: null,
        images: [{ mediaId: 'm_1', alt: { en: 'A mug' } }],
        options: [
          {
            id: 'p-test-mug__color',
            name: { en: 'Color' },
            type: 'swatch',
            values: [
              { id: 'p-test-mug__color__red', label: { en: 'Red' }, swatch: '#C04A17' },
              { id: 'p-test-mug__color__blue', label: { en: 'Blue' }, swatch: '#1F4E79' },
            ],
          },
        ],
        variants: [
          { id: 'p-test-mug--v-red', sku: 'TEST-MUG-RED', options: { 'p-test-mug__color': 'p-test-mug__color__red' }, price: 1500, salePrice: null, stock: 5, imageIds: ['m_1'] },
          { id: 'p-test-mug--v-blue', sku: 'TEST-MUG-BLUE', options: { 'p-test-mug__color': 'p-test-mug__color__blue' }, price: 1500, salePrice: null, stock: 0, imageIds: [] },
        ],
        weight: { value: null, unit: 'g' },
        dimensions: { length: null, width: null, height: null, unit: 'cm' },
        specs: [{ id: 'p-test-mug__spec__s1', label: { en: 'Capacity' }, value: { en: '350 ml' } }],
        createdAt: '2026-03-01T10:00:00.000Z',
        updatedAt: '2026-03-01T10:00:00.000Z',
      });
    });

    it('answers 404 for an unknown id', async () => {
      mocks.prisma.product.findUnique.mockResolvedValue(null);
      const res = await request(app).get('/api/admin/products/p-missing').set('Cookie', session.cookie);
      expect(res.status).toBe(404);
      expect(res.body).toEqual(NOT_FOUND);
    });
  });

  describe('POST /', () => {
    it('creates a product (id p-<slug>) in one transaction and returns it with 201', async () => {
      mocks.prisma.product.findUniqueOrThrow.mockResolvedValue(productRow());

      const res = await write(request(app).post('/api/admin/products')).send(validProductBody());

      expect(res.status).toBe(201);
      expect(res.body.id).toBe('p-test-mug');
      expect(mocks.prisma.category.findUnique).toHaveBeenCalledWith({ where: { id: 'ceramics' }, select: { id: true, isActive: true } });
      expect(mocks.prisma.productVariant.findMany).toHaveBeenCalledWith({
        where: { sku: { in: ['TEST-MUG-1'] } },
        select: { sku: true, product: { select: { nameEn: true } } },
      });
      expect(mocks.prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(mocks.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { maxWait: 10_000, timeout: 30_000 });
      expect(mocks.tx.product.create).toHaveBeenCalledWith({
        data: {
          id: 'p-test-mug',
          slug: 'test-mug',
          status: 'draft',
          nameEn: 'Test Mug',
          nameHi: '',
          shortDescriptionEn: '',
          shortDescriptionHi: '',
          descriptionEn: '',
          descriptionHi: '',
          categoryId: 'ceramics',
          itemGroupId: null,
          navLinkId: null,
          tags: '[]',
          nameSearch: 'test mug',
          searchText: 'test mug test-mug test-mug-1',
          basePrice: 1500,
          baseSalePrice: null,
          materialsEn: '',
          materialsHi: '',
          careEn: '',
          careHi: '',
          returnsAllowed: true,
          exchangeAllowed: true,
          returnDays: 30,
          weightValue: null,
          weightUnit: 'g',
          dimLength: null,
          dimWidth: null,
          dimHeight: null,
          dimUnit: 'cm',
          isFeatured: false,
          isBestseller: false,
          isNew: false,
          displayOrder: 100,
          seoTitleEn: '',
          seoTitleHi: '',
          seoDescriptionEn: '',
          seoDescriptionHi: '',
        },
      });
      expect(mocks.tx.productVariant.createMany).toHaveBeenCalledWith({
        data: [{ id: 'p-test-mug--v1', productId: 'p-test-mug', sku: 'TEST-MUG-1', options: '{}', price: 1500, salePrice: null, stock: 5, imageIds: '[]', position: 0 }],
      });
      expect(mocks.tx.product.update).not.toHaveBeenCalled();
      expect(mocks.tx.productImage.createMany).not.toHaveBeenCalled();
      expect(mocks.tx.productOption.create).not.toHaveBeenCalled();
      expect(mocks.tx.productSpec.createMany).not.toHaveBeenCalled();
    });

    it('answers 400 with field issues for an invalid body, before any lookup', async () => {
      const res = await write(request(app).post('/api/admin/products')).send({});
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation');
      expect(res.body.error.message).toBe('Please fix the highlighted fields.');
      expect(res.body.error.issues.map((i: { path: string }) => i.path)).toEqual(expect.arrayContaining(['slug', 'name', 'categoryId', 'basePrice', 'variants']));
      expect(mocks.prisma.category.findUnique).not.toHaveBeenCalled();
      expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    });

    it('answers 400 when the category does not exist', async () => {
      mocks.prisma.category.findUnique.mockResolvedValue(null);
      const res = await write(request(app).post('/api/admin/products')).send(validProductBody());
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: { code: 'validation', message: 'Choose an existing category.', issues: [{ path: 'categoryId', message: 'Category not found.' }] } });
      expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    });

    it('answers 409 when publishing into an inactive category', async () => {
      mocks.prisma.category.findUnique.mockResolvedValue({ id: 'ceramics', isActive: false });
      const res = await write(request(app).post('/api/admin/products')).send(activeBody());
      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        error: {
          code: 'conflict',
          message: 'Its category is inactive, so the product would stay hidden. Activate the category first.',
          issues: [{ path: 'categoryId', message: 'Category is inactive.' }],
        },
      });
      expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    });

    it('answers 400 when an image reference no longer exists', async () => {
      mocks.prisma.media.findMany.mockResolvedValue([]);
      const res = await write(request(app).post('/api/admin/products')).send(validProductBody({ images: [{ mediaId: 'm_missing', alt: { en: '' } }] }));
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: { code: 'validation', message: 'Unknown image reference: m_missing.', issues: [{ path: 'images', message: 'Image no longer exists.' }] } });
      expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    });

    it('answers 409 when a SKU is already used by another product', async () => {
      mocks.prisma.productVariant.findMany.mockResolvedValue([{ sku: 'TEST-MUG-1', product: { nameEn: 'Other Mug' } }]);
      const res = await write(request(app).post('/api/admin/products')).send(validProductBody());
      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        error: { code: 'conflict', message: 'SKU already used by "Other Mug".', issues: [{ path: 'variants.0.sku', message: 'SKU already used by "Other Mug".' }] },
      });
      expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('PUT /:id', () => {
    it('answers 404 for an unknown id even when the body is invalid (existence is checked first)', async () => {
      mocks.prisma.product.findUnique.mockResolvedValue(null);

      const res = await write(request(app).put('/api/admin/products/p-missing')).send({});

      expect(res.status).toBe(404);
      expect(res.body).toEqual(NOT_FOUND);
      expect(mocks.prisma.product.findUnique).toHaveBeenCalledWith({ where: { id: 'p-missing' }, select: { id: true } });
      expect(mocks.prisma.category.findUnique).not.toHaveBeenCalled();
    });

    it('answers 400 for an invalid body once the product exists', async () => {
      mocks.prisma.product.findUnique.mockResolvedValue({ id: 'p-test-mug' });
      const res = await write(request(app).put('/api/admin/products/p-test-mug')).send({ slug: 'Bad Slug' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation');
      expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    });

    it('replaces the product and its children in one transaction, excluding itself from the SKU check', async () => {
      mocks.prisma.product.findUnique.mockResolvedValue({ id: 'p-test-mug' });
      mocks.prisma.product.findUniqueOrThrow.mockResolvedValue(productRow());

      const res = await write(request(app).put('/api/admin/products/p-test-mug')).send(validProductBody());

      expect(res.status).toBe(200);
      expect(res.body.id).toBe('p-test-mug');
      expect(mocks.prisma.productVariant.findMany).toHaveBeenCalledWith({
        where: { sku: { in: ['TEST-MUG-1'] }, NOT: { productId: 'p-test-mug' } },
        select: { sku: true, product: { select: { nameEn: true } } },
      });
      expect(mocks.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { maxWait: 10_000, timeout: 30_000 });
      expect(mocks.tx.product.update).toHaveBeenCalledWith({ where: { id: 'p-test-mug' }, data: expect.objectContaining({ slug: 'test-mug', nameEn: 'Test Mug' }) });
      expect(mocks.tx.product.create).not.toHaveBeenCalled();
      for (const model of [mocks.tx.productImage, mocks.tx.productOption, mocks.tx.productVariant, mocks.tx.productSpec]) {
        expect(model.deleteMany).toHaveBeenCalledWith({ where: { productId: 'p-test-mug' } });
      }
    });
  });

  describe('PATCH /:id/status', () => {
    it('validates the status before looking the product up', async () => {
      const res = await write(request(app).patch('/api/admin/products/p-test-mug/status')).send({ status: 'live' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation');
      expect(mocks.prisma.product.findUnique).not.toHaveBeenCalled();
    });

    it('answers 404 for an unknown id', async () => {
      mocks.prisma.product.findUnique.mockResolvedValue(null);
      const res = await write(request(app).patch('/api/admin/products/p-missing/status')).send({ status: 'archived' });
      expect(res.status).toBe(404);
      expect(res.body).toEqual(NOT_FOUND);
    });

    it('archives without re-running the publish rules', async () => {
      mocks.prisma.product.findUnique.mockResolvedValue(productRow({ images: [] }));
      mocks.prisma.product.update.mockResolvedValue(productRow({ status: 'archived' }));

      const res = await write(request(app).patch('/api/admin/products/p-test-mug/status')).send({ status: 'archived' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('archived');
      expect(mocks.prisma.product.update).toHaveBeenCalledWith({ where: { id: 'p-test-mug' }, data: { status: 'archived' }, include: PRODUCT_INCLUDE });
    });

    it('publishes a complete product', async () => {
      mocks.prisma.product.findUnique.mockResolvedValue(productRow());
      mocks.prisma.product.update.mockResolvedValue(productRow({ status: 'active' }));

      const res = await write(request(app).patch('/api/admin/products/p-test-mug/status')).send({ status: 'active' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('active');
      expect(mocks.prisma.product.update).toHaveBeenCalledWith({ where: { id: 'p-test-mug' }, data: { status: 'active' }, include: PRODUCT_INCLUDE });
    });

    it('refuses to publish an incomplete product with the full list of problems', async () => {
      mocks.prisma.product.findUnique.mockResolvedValue(productRow({ images: [] }));

      const res = await write(request(app).patch('/api/admin/products/p-test-mug/status')).send({ status: 'active' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation');
      expect(res.body.error.message).toBe('This product cannot be published yet.');
      expect(res.body.error.issues).toEqual(expect.arrayContaining([{ path: 'images', message: 'Add at least one image before activating.' }]));
      expect(mocks.prisma.product.update).not.toHaveBeenCalled();
    });

    it('refuses to publish into an inactive category', async () => {
      const row = productRow();
      mocks.prisma.product.findUnique.mockResolvedValue({ ...row, category: { ...row.category, isActive: false } });

      const res = await write(request(app).patch('/api/admin/products/p-test-mug/status')).send({ status: 'active' });

      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: { code: 'conflict', message: 'Its category is inactive, so it would stay hidden. Activate the category first.', issues: [] } });
      expect(mocks.prisma.product.update).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /all', () => {
    it('removes every product and its children in one transaction, children first', async () => {
      const res = await write(request(app).delete('/api/admin/products/all'));

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(mocks.prisma.$transaction).toHaveBeenCalledTimes(1);
      const order = [
        mocks.tx.productImage.deleteMany,
        mocks.tx.productOptionValue.deleteMany,
        mocks.tx.productOption.deleteMany,
        mocks.tx.productVariant.deleteMany,
        mocks.tx.productSpec.deleteMany,
        mocks.tx.product.deleteMany,
      ].map((fn) => {
        expect(fn).toHaveBeenCalledTimes(1);
        expect(fn).toHaveBeenCalledWith();
        return fn.mock.invocationCallOrder[0];
      });
      expect(order).toEqual([...order].sort((a, b) => a - b));
    });
  });
});
