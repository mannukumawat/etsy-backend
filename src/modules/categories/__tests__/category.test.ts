import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Hermetic regression tests for /api/admin/categories: Prisma is mocked, no database is touched.

const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
  process.env.JWT_SECRET ??= 'test-only-jwt-secret-0123456789';
  return {
    prisma: {
      owner: { findUnique: vi.fn() },
      category: { findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
      media: { findMany: vi.fn() },
    },
  };
});
vi.mock('../../../shared/database/prisma.js', () => ({ prisma: mocks.prisma, assertDatabaseReachable: vi.fn() }));

import { createApp } from '../../../app.js';
import { CSRF_FORBIDDEN_BODY, UNAUTHORIZED_BODY, findOwner, loginAsOwner, type Session } from '../../../__tests__/support/owner-session.js';

const app = createApp();
const TIME = new Date('2026-03-01T10:00:00.000Z');

const categoryRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'bowls',
  slug: 'bowls',
  nameEn: 'Bowls',
  nameHi: '',
  descriptionEn: 'Hand-thrown bowls',
  descriptionHi: '',
  imageId: 'm_1',
  bannerId: null,
  displayOrder: 2,
  isActive: true,
  createdAt: TIME,
  updatedAt: TIME,
  ...overrides,
});

const adminCategory = (productCount: number) => ({
  id: 'bowls',
  slug: 'bowls',
  name: { en: 'Bowls' },
  description: { en: 'Hand-thrown bowls' },
  imageId: 'm_1',
  bannerId: null,
  displayOrder: 2,
  isActive: true,
  createdAt: '2026-03-01T10:00:00.000Z',
  updatedAt: '2026-03-01T10:00:00.000Z',
  productCount,
});

const validBody = { slug: 'bowls', name: { en: 'Bowls' }, description: { en: 'Hand-thrown bowls' }, imageId: 'm_1', bannerId: null, displayOrder: 2, isActive: true };

describe('admin categories (/api/admin/categories)', () => {
  let session: Session;

  beforeAll(async () => {
    mocks.prisma.owner.findUnique.mockImplementation(findOwner);
    session = await loginAsOwner(app);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.owner.findUnique.mockImplementation(findOwner);
    mocks.prisma.media.findMany.mockResolvedValue([{ id: 'm_1' }]);
  });

  describe('authorization', () => {
    it('rejects anonymous list, create and update before touching the database', async () => {
      for (const res of [
        await request(app).get('/api/admin/categories'),
        await request(app).post('/api/admin/categories').send(validBody),
        await request(app).put('/api/admin/categories/bowls').send(validBody),
      ]) {
        expect(res.status).toBe(401);
        expect(res.body).toEqual(UNAUTHORIZED_BODY);
      }
      expect(mocks.prisma.category.findMany).not.toHaveBeenCalled();
      expect(mocks.prisma.category.create).not.toHaveBeenCalled();
      expect(mocks.prisma.category.update).not.toHaveBeenCalled();
    });

    it('rejects a signed-in create/update without a matching csrf header', async () => {
      for (const res of [
        await request(app).post('/api/admin/categories').set('Cookie', session.cookie).send(validBody),
        await request(app).put('/api/admin/categories/bowls').set('Cookie', session.cookie).set('x-csrf-token', 'wrong').send(validBody),
      ]) {
        expect(res.status).toBe(403);
        expect(res.body).toEqual(CSRF_FORBIDDEN_BODY);
      }
      expect(mocks.prisma.category.create).not.toHaveBeenCalled();
      expect(mocks.prisma.category.update).not.toHaveBeenCalled();
    });
  });

  describe('GET /', () => {
    it('lists categories ordered by displayOrder then name, each with its product count', async () => {
      mocks.prisma.category.findMany.mockResolvedValue([{ ...categoryRow(), _count: { products: 3 } }]);

      const res = await request(app).get('/api/admin/categories').set('Cookie', session.cookie);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ items: [adminCategory(3)] });
      expect(mocks.prisma.category.findMany).toHaveBeenCalledWith({
        orderBy: [{ displayOrder: 'asc' }, { nameEn: 'asc' }],
        include: { _count: { select: { products: true } } },
      });
    });
  });

  describe('POST /', () => {
    it('creates a category (id = slug) after checking the referenced images exist', async () => {
      mocks.prisma.category.create.mockResolvedValue(categoryRow());

      const res = await request(app).post('/api/admin/categories').set('Cookie', session.cookie).set('x-csrf-token', session.csrf).send(validBody);

      expect(res.status).toBe(201);
      expect(res.body).toEqual(adminCategory(0));
      expect(mocks.prisma.media.findMany).toHaveBeenCalledWith({ where: { id: { in: ['m_1'] } }, select: { id: true } });
      expect(mocks.prisma.category.create).toHaveBeenCalledWith({
        data: {
          id: 'bowls',
          slug: 'bowls',
          nameEn: 'Bowls',
          nameHi: '',
          descriptionEn: 'Hand-thrown bowls',
          descriptionHi: '',
          imageId: 'm_1',
          bannerId: null,
          displayOrder: 2,
          isActive: true,
        },
      });
    });

    it('answers 400 with field issues for an invalid body', async () => {
      const res = await request(app).post('/api/admin/categories').set('Cookie', session.cookie).set('x-csrf-token', session.csrf).send({ slug: 'Not A Slug', name: { en: '' } });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation');
      expect(res.body.error.issues).toEqual(
        expect.arrayContaining([
          { path: 'slug', message: 'Use lowercase letters, numbers and single hyphens.' },
          { path: 'name.en', message: 'English text is required.' },
        ]),
      );
      expect(mocks.prisma.category.create).not.toHaveBeenCalled();
    });

    it('answers 400 when a referenced image no longer exists', async () => {
      mocks.prisma.media.findMany.mockResolvedValue([]);

      const res = await request(app).post('/api/admin/categories').set('Cookie', session.cookie).set('x-csrf-token', session.csrf).send(validBody);

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: { code: 'validation', message: 'Unknown image reference: m_1.', issues: [{ path: 'images', message: 'Image no longer exists.' }] },
      });
      expect(mocks.prisma.category.create).not.toHaveBeenCalled();
    });

    it('maps a duplicate slug (unique constraint) to 409', async () => {
      mocks.prisma.category.create.mockRejectedValue(Object.assign(new Error('Unique constraint failed'), { code: 'P2002', meta: { target: ['slug'] } }));

      const res = await request(app).post('/api/admin/categories').set('Cookie', session.cookie).set('x-csrf-token', session.csrf).send(validBody);

      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: { code: 'conflict', message: 'That slug is already in use.', issues: [{ path: 'slug', message: 'Already in use.' }] } });
    });
  });

  describe('PUT /:id', () => {
    it('updates by id and returns the category with its product count', async () => {
      mocks.prisma.category.update.mockResolvedValue({ ...categoryRow(), _count: { products: 4 } });

      const res = await request(app).put('/api/admin/categories/bowls').set('Cookie', session.cookie).set('x-csrf-token', session.csrf).send(validBody);

      expect(res.status).toBe(200);
      expect(res.body).toEqual(adminCategory(4));
      expect(mocks.prisma.category.update).toHaveBeenCalledWith({
        where: { id: 'bowls' },
        data: {
          slug: 'bowls',
          nameEn: 'Bowls',
          nameHi: '',
          descriptionEn: 'Hand-thrown bowls',
          descriptionHi: '',
          imageId: 'm_1',
          bannerId: null,
          displayOrder: 2,
          isActive: true,
        },
        include: { _count: { select: { products: true } } },
      });
    });

    it('answers 404 for an unknown id', async () => {
      mocks.prisma.category.update.mockRejectedValue(Object.assign(new Error('Record not found'), { code: 'P2025' }));

      const res = await request(app).put('/api/admin/categories/missing').set('Cookie', session.cookie).set('x-csrf-token', session.csrf).send(validBody);

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: { code: 'not_found', message: 'Not found.', issues: [] } });
    });
  });
});
