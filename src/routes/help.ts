import { Router } from 'express';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import { requireOwner } from '../auth.js';
import { prisma } from '../db.js';
import { badRequest, notFound, route } from '../http.js';

// ── Types ──────────────────────────────────────────────────────────────────

type RawCat = {
  id: string; slug: string; nameEn: string; nameHi: string;
  descriptionEn: string | null; descriptionHi: string | null;
  icon: string; position: number; isActive: number;
  createdAt: Date; updatedAt: Date;
};
type RawArticle = {
  id: string; categoryId: string; slug: string;
  titleEn: string; titleHi: string; bodyEn: string; bodyHi: string | null;
  position: number; isActive: number; createdAt: Date; updatedAt: Date;
};

function mapCat(r: RawCat) {
  return {
    id: r.id, slug: r.slug,
    name: { en: r.nameEn, hi: r.nameHi || '' },
    description: { en: r.descriptionEn ?? '', hi: r.descriptionHi ?? '' },
    icon: r.icon, position: r.position, isActive: !!r.isActive,
    createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}
function mapArticle(r: RawArticle) {
  return {
    id: r.id, categoryId: r.categoryId, slug: r.slug,
    title: { en: r.titleEn, hi: r.titleHi || '' },
    body: { en: r.bodyEn, hi: r.bodyHi ?? '' },
    position: r.position, isActive: !!r.isActive,
    createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}

function newId() { return randomBytes(10).toString('hex'); }

// ── Public ─────────────────────────────────────────────────────────────────

export const publicHelpRouter = Router();

// GET /api/help/categories
publicHelpRouter.get('/categories', route(async (_req, res) => {
  const rows = await prisma.$queryRawUnsafe<RawCat[]>(
    `SELECT * FROM help_categories WHERE isActive = 1 ORDER BY position ASC, nameEn ASC`
  );
  res.json({ items: rows.map(mapCat) });
}));

// GET /api/help/categories/:slug
publicHelpRouter.get('/categories/:slug', route(async (req, res) => {
  const [cat] = await prisma.$queryRawUnsafe<RawCat[]>(
    `SELECT * FROM help_categories WHERE slug = ? AND isActive = 1`, req.params.slug
  );
  if (!cat) throw notFound('Category not found.');
  const articles = await prisma.$queryRawUnsafe<RawArticle[]>(
    `SELECT * FROM help_articles WHERE categoryId = ? AND isActive = 1 ORDER BY position ASC, titleEn ASC`,
    cat.id
  );
  res.json({ category: mapCat(cat), articles: articles.map(mapArticle) });
}));

// GET /api/help/categories/:catSlug/articles/:slug
publicHelpRouter.get('/categories/:catSlug/articles/:slug', route(async (req, res) => {
  const [cat] = await prisma.$queryRawUnsafe<RawCat[]>(
    `SELECT * FROM help_categories WHERE slug = ? AND isActive = 1`, req.params.catSlug
  );
  if (!cat) throw notFound('Category not found.');
  const [article] = await prisma.$queryRawUnsafe<RawArticle[]>(
    `SELECT * FROM help_articles WHERE categoryId = ? AND slug = ? AND isActive = 1`,
    cat.id, req.params.slug
  );
  if (!article) throw notFound('Article not found.');
  res.json({ category: mapCat(cat), article: mapArticle(article) });
}));

// ── Admin ──────────────────────────────────────────────────────────────────

export const adminHelpRouter = Router();
adminHelpRouter.use(requireOwner);

const catInputSchema = z.object({
  slug: z.string().trim().min(1).max(100).regex(/^[a-z0-9-]+$/, 'Slug: lowercase letters, digits and hyphens only'),
  nameEn: z.string().trim().min(1).max(200),
  nameHi: z.string().trim().max(200).default(''),
  descriptionEn: z.string().trim().max(1000).nullable().default(null),
  descriptionHi: z.string().trim().max(1000).nullable().default(null),
  icon: z.string().trim().max(50).default('help-circle'),
  position: z.number().int().default(0),
  isActive: z.boolean().default(true),
});

const articleInputSchema = z.object({
  slug: z.string().trim().min(1).max(150).regex(/^[a-z0-9-]+$/, 'Slug: lowercase letters, digits and hyphens only'),
  titleEn: z.string().trim().min(1).max(300),
  titleHi: z.string().trim().max(300).default(''),
  bodyEn: z.string().trim().min(1),
  bodyHi: z.string().trim().default(''),
  position: z.number().int().default(0),
  isActive: z.boolean().default(true),
});

// --- Categories ---

adminHelpRouter.get('/categories', route(async (_req, res) => {
  const rows = await prisma.$queryRawUnsafe<RawCat[]>(
    `SELECT * FROM help_categories ORDER BY position ASC, nameEn ASC`
  );
  res.json({ items: rows.map(mapCat) });
}));

adminHelpRouter.post('/categories', route(async (req, res) => {
  const data = catInputSchema.parse(req.body);
  const existing = await prisma.$queryRawUnsafe<RawCat[]>(`SELECT id FROM help_categories WHERE slug = ?`, data.slug);
  if (existing.length) throw badRequest('Slug already in use.');
  const id = newId();
  await prisma.$executeRawUnsafe(
    `INSERT INTO help_categories (id, slug, nameEn, nameHi, descriptionEn, descriptionHi, icon, position, isActive, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3), NOW(3))`,
    id, data.slug, data.nameEn, data.nameHi, data.descriptionEn, data.descriptionHi,
    data.icon, data.position, data.isActive ? 1 : 0,
  );
  const [row] = await prisma.$queryRawUnsafe<RawCat[]>(`SELECT * FROM help_categories WHERE id = ?`, id);
  res.status(201).json(mapCat(row));
}));

adminHelpRouter.patch('/categories/:id', route(async (req, res) => {
  const [row] = await prisma.$queryRawUnsafe<RawCat[]>(`SELECT * FROM help_categories WHERE id = ?`, req.params.id);
  if (!row) throw notFound('Category not found.');
  const data = catInputSchema.parse({ ...mapCat(row), name: undefined, description: undefined, nameEn: row.nameEn, nameHi: row.nameHi, descriptionEn: row.descriptionEn, descriptionHi: row.descriptionHi, ...req.body });
  await prisma.$executeRawUnsafe(
    `UPDATE help_categories SET slug=?, nameEn=?, nameHi=?, descriptionEn=?, descriptionHi=?, icon=?, position=?, isActive=?, updatedAt=NOW(3) WHERE id=?`,
    data.slug, data.nameEn, data.nameHi, data.descriptionEn, data.descriptionHi,
    data.icon, data.position, data.isActive ? 1 : 0, row.id,
  );
  const [updated] = await prisma.$queryRawUnsafe<RawCat[]>(`SELECT * FROM help_categories WHERE id = ?`, row.id);
  res.json(mapCat(updated));
}));

adminHelpRouter.delete('/categories/:id', route(async (req, res) => {
  await prisma.$executeRawUnsafe(`DELETE FROM help_categories WHERE id = ?`, req.params.id);
  res.json({ ok: true });
}));

// --- Articles ---

adminHelpRouter.get('/categories/:catId/articles', route(async (req, res) => {
  const rows = await prisma.$queryRawUnsafe<RawArticle[]>(
    `SELECT * FROM help_articles WHERE categoryId = ? ORDER BY position ASC, titleEn ASC`, req.params.catId
  );
  res.json({ items: rows.map(mapArticle) });
}));

adminHelpRouter.post('/categories/:catId/articles', route(async (req, res) => {
  const [cat] = await prisma.$queryRawUnsafe<RawCat[]>(`SELECT id FROM help_categories WHERE id = ?`, req.params.catId);
  if (!cat) throw notFound('Category not found.');
  const data = articleInputSchema.parse(req.body);
  const existing = await prisma.$queryRawUnsafe<RawArticle[]>(
    `SELECT id FROM help_articles WHERE categoryId = ? AND slug = ?`, cat.id, data.slug
  );
  if (existing.length) throw badRequest('Slug already in use in this category.');
  const id = newId();
  await prisma.$executeRawUnsafe(
    `INSERT INTO help_articles (id, categoryId, slug, titleEn, titleHi, bodyEn, bodyHi, position, isActive, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3), NOW(3))`,
    id, cat.id, data.slug, data.titleEn, data.titleHi, data.bodyEn, data.bodyHi,
    data.position, data.isActive ? 1 : 0,
  );
  const [row] = await prisma.$queryRawUnsafe<RawArticle[]>(`SELECT * FROM help_articles WHERE id = ?`, id);
  res.status(201).json(mapArticle(row));
}));

adminHelpRouter.patch('/categories/:catId/articles/:id', route(async (req, res) => {
  const [row] = await prisma.$queryRawUnsafe<RawArticle[]>(
    `SELECT * FROM help_articles WHERE id = ? AND categoryId = ?`, req.params.id, req.params.catId
  );
  if (!row) throw notFound('Article not found.');
  const data = articleInputSchema.parse({ titleEn: row.titleEn, titleHi: row.titleHi, bodyEn: row.bodyEn, bodyHi: row.bodyHi ?? '', slug: row.slug, position: row.position, isActive: !!row.isActive, ...req.body });
  await prisma.$executeRawUnsafe(
    `UPDATE help_articles SET slug=?, titleEn=?, titleHi=?, bodyEn=?, bodyHi=?, position=?, isActive=?, updatedAt=NOW(3) WHERE id=?`,
    data.slug, data.titleEn, data.titleHi, data.bodyEn, data.bodyHi,
    data.position, data.isActive ? 1 : 0, row.id,
  );
  const [updated] = await prisma.$queryRawUnsafe<RawArticle[]>(`SELECT * FROM help_articles WHERE id = ?`, row.id);
  res.json(mapArticle(updated));
}));

adminHelpRouter.delete('/categories/:catId/articles/:id', route(async (req, res) => {
  await prisma.$executeRawUnsafe(`DELETE FROM help_articles WHERE id = ? AND categoryId = ?`, req.params.id, req.params.catId);
  res.json({ ok: true });
}));
