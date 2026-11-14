import { Router } from 'express';
import { route } from '../../shared/http/async-route.js';
import { toHelpArticle, toHelpCategory } from './help.mapper.js';
import { getActiveHelpArticle, getActiveHelpCategoryWithArticles, listActiveHelpCategories } from './help.service.js';

export const publicHelpRouter = Router();

// GET /api/help/categories
publicHelpRouter.get('/categories', route(async (_req, res) => {
  const rows = await listActiveHelpCategories();
  res.json({ items: rows.map(toHelpCategory) });
}));

// GET /api/help/categories/:slug
publicHelpRouter.get('/categories/:slug', route(async (req, res) => {
  const { category, articles } = await getActiveHelpCategoryWithArticles(req.params.slug);
  res.json({ category: toHelpCategory(category), articles: articles.map(toHelpArticle) });
}));

// GET /api/help/categories/:catSlug/articles/:slug
publicHelpRouter.get('/categories/:catSlug/articles/:slug', route(async (req, res) => {
  const { category, article } = await getActiveHelpArticle(req.params.catSlug, req.params.slug);
  res.json({ category: toHelpCategory(category), article: toHelpArticle(article) });
}));
