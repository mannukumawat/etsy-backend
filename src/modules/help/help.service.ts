import { prisma } from '../../shared/database/prisma.js';
import { badRequest, notFound } from '../../shared/errors/http-error.js';
import { randomHexId } from '../../shared/utils/ids.js';
import { toHelpCategory } from './help.mapper.js';
import { helpArticleInputSchema, helpCategoryInputSchema, type HelpCategoryInput } from './help.schema.js';
import type { HelpArticleRow, HelpCategoryRow } from './help.types.js';

// ── Public ─────────────────────────────────────────────────────────────────

export function listActiveHelpCategories() {
  return prisma.$queryRawUnsafe<HelpCategoryRow[]>(
    `SELECT * FROM help_categories WHERE isActive = 1 ORDER BY position ASC, nameEn ASC`
  );
}

export async function getActiveHelpCategoryWithArticles(slug: string) {
  const [cat] = await prisma.$queryRawUnsafe<HelpCategoryRow[]>(
    `SELECT * FROM help_categories WHERE slug = ? AND isActive = 1`, slug
  );
  if (!cat) throw notFound('Category not found.');
  const articles = await prisma.$queryRawUnsafe<HelpArticleRow[]>(
    `SELECT * FROM help_articles WHERE categoryId = ? AND isActive = 1 ORDER BY position ASC, titleEn ASC`,
    cat.id
  );
  return { category: cat, articles };
}

export async function getActiveHelpArticle(categorySlug: string, slug: string) {
  const [cat] = await prisma.$queryRawUnsafe<HelpCategoryRow[]>(
    `SELECT * FROM help_categories WHERE slug = ? AND isActive = 1`, categorySlug
  );
  if (!cat) throw notFound('Category not found.');
  const [article] = await prisma.$queryRawUnsafe<HelpArticleRow[]>(
    `SELECT * FROM help_articles WHERE categoryId = ? AND slug = ? AND isActive = 1`,
    cat.id, slug
  );
  if (!article) throw notFound('Article not found.');
  return { category: cat, article };
}

// ── Admin: categories ──────────────────────────────────────────────────────

export function listHelpCategories() {
  return prisma.$queryRawUnsafe<HelpCategoryRow[]>(
    `SELECT * FROM help_categories ORDER BY position ASC, nameEn ASC`
  );
}

export async function createHelpCategory(data: HelpCategoryInput) {
  const existing = await prisma.$queryRawUnsafe<HelpCategoryRow[]>(`SELECT id FROM help_categories WHERE slug = ?`, data.slug);
  if (existing.length) throw badRequest('Slug already in use.');
  const id = randomHexId(10);
  await prisma.$executeRawUnsafe(
    `INSERT INTO help_categories (id, slug, nameEn, nameHi, descriptionEn, descriptionHi, icon, position, isActive, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3), NOW(3))`,
    id, data.slug, data.nameEn, data.nameHi, data.descriptionEn, data.descriptionHi,
    data.icon, data.position, data.isActive ? 1 : 0,
  );
  const [row] = await prisma.$queryRawUnsafe<HelpCategoryRow[]>(`SELECT * FROM help_categories WHERE id = ?`, id);
  return row;
}

/** Partial update: the stored category supplies the defaults, `patch` overrides them, and the merged
 *  object is validated with the full input schema. The category must exist (404) before anything in
 *  `patch` is validated (400), so the body is parsed here rather than by the route. */
export async function updateHelpCategory(id: string, patch: Record<string, unknown>) {
  const [row] = await prisma.$queryRawUnsafe<HelpCategoryRow[]>(`SELECT * FROM help_categories WHERE id = ?`, id);
  if (!row) throw notFound('Category not found.');
  const data = helpCategoryInputSchema.parse({ ...toHelpCategory(row), name: undefined, description: undefined, nameEn: row.nameEn, nameHi: row.nameHi, descriptionEn: row.descriptionEn, descriptionHi: row.descriptionHi, ...patch });
  await prisma.$executeRawUnsafe(
    `UPDATE help_categories SET slug=?, nameEn=?, nameHi=?, descriptionEn=?, descriptionHi=?, icon=?, position=?, isActive=?, updatedAt=NOW(3) WHERE id=?`,
    data.slug, data.nameEn, data.nameHi, data.descriptionEn, data.descriptionHi,
    data.icon, data.position, data.isActive ? 1 : 0, row.id,
  );
  const [updated] = await prisma.$queryRawUnsafe<HelpCategoryRow[]>(`SELECT * FROM help_categories WHERE id = ?`, row.id);
  return updated;
}

export async function deleteHelpCategory(id: string) {
  await prisma.$executeRawUnsafe(`DELETE FROM help_categories WHERE id = ?`, id);
}

// ── Admin: articles ────────────────────────────────────────────────────────

export function listHelpArticles(categoryId: string) {
  return prisma.$queryRawUnsafe<HelpArticleRow[]>(
    `SELECT * FROM help_articles WHERE categoryId = ? ORDER BY position ASC, titleEn ASC`, categoryId
  );
}

/** The category must exist (404) before `body` is validated (400), so the body is parsed here rather
 *  than by the route. */
export async function createHelpArticle(categoryId: string, body: unknown) {
  const [cat] = await prisma.$queryRawUnsafe<HelpCategoryRow[]>(`SELECT id FROM help_categories WHERE id = ?`, categoryId);
  if (!cat) throw notFound('Category not found.');
  const data = helpArticleInputSchema.parse(body);
  const existing = await prisma.$queryRawUnsafe<HelpArticleRow[]>(
    `SELECT id FROM help_articles WHERE categoryId = ? AND slug = ?`, cat.id, data.slug
  );
  if (existing.length) throw badRequest('Slug already in use in this category.');
  const id = randomHexId(10);
  await prisma.$executeRawUnsafe(
    `INSERT INTO help_articles (id, categoryId, slug, titleEn, titleHi, bodyEn, bodyHi, position, isActive, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3), NOW(3))`,
    id, cat.id, data.slug, data.titleEn, data.titleHi, data.bodyEn, data.bodyHi,
    data.position, data.isActive ? 1 : 0,
  );
  const [row] = await prisma.$queryRawUnsafe<HelpArticleRow[]>(`SELECT * FROM help_articles WHERE id = ?`, id);
  return row;
}

/** Partial update, same merge-then-validate rule as `updateHelpCategory` (article must exist first). */
export async function updateHelpArticle(categoryId: string, id: string, patch: Record<string, unknown>) {
  const [row] = await prisma.$queryRawUnsafe<HelpArticleRow[]>(
    `SELECT * FROM help_articles WHERE id = ? AND categoryId = ?`, id, categoryId
  );
  if (!row) throw notFound('Article not found.');
  const data = helpArticleInputSchema.parse({ titleEn: row.titleEn, titleHi: row.titleHi, bodyEn: row.bodyEn, bodyHi: row.bodyHi ?? '', slug: row.slug, position: row.position, isActive: !!row.isActive, ...patch });
  await prisma.$executeRawUnsafe(
    `UPDATE help_articles SET slug=?, titleEn=?, titleHi=?, bodyEn=?, bodyHi=?, position=?, isActive=?, updatedAt=NOW(3) WHERE id=?`,
    data.slug, data.titleEn, data.titleHi, data.bodyEn, data.bodyHi,
    data.position, data.isActive ? 1 : 0, row.id,
  );
  const [updated] = await prisma.$queryRawUnsafe<HelpArticleRow[]>(`SELECT * FROM help_articles WHERE id = ?`, row.id);
  return updated;
}

export async function deleteHelpArticle(categoryId: string, id: string) {
  await prisma.$executeRawUnsafe(`DELETE FROM help_articles WHERE id = ? AND categoryId = ?`, id, categoryId);
}
