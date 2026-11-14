import type { HelpArticleRow, HelpCategoryRow } from './help.types.js';

export function toHelpCategory(r: HelpCategoryRow) {
  return {
    id: r.id, slug: r.slug,
    name: { en: r.nameEn, hi: r.nameHi || '' },
    description: { en: r.descriptionEn ?? '', hi: r.descriptionHi ?? '' },
    icon: r.icon, position: r.position, isActive: !!r.isActive,
    createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}

export function toHelpArticle(r: HelpArticleRow) {
  return {
    id: r.id, categoryId: r.categoryId, slug: r.slug,
    title: { en: r.titleEn, hi: r.titleHi || '' },
    body: { en: r.bodyEn, hi: r.bodyHi ?? '' },
    position: r.position, isActive: !!r.isActive,
    createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}
