import { Router } from 'express';
import { route } from '../../shared/http/async-route.js';
import { requireOwner } from '../../shared/middleware/auth.middleware.js';
import { toHelpArticle, toHelpCategory } from './help.mapper.js';
import { helpCategoryInputSchema } from './help.schema.js';
import {
  createHelpArticle,
  createHelpCategory,
  deleteHelpArticle,
  deleteHelpCategory,
  listHelpArticles,
  listHelpCategories,
  updateHelpArticle,
  updateHelpCategory,
} from './help.service.js';

export const adminHelpRouter = Router();
adminHelpRouter.use(requireOwner);

// --- Categories ---

adminHelpRouter.get('/categories', route(async (_req, res) => {
  const rows = await listHelpCategories();
  res.json({ items: rows.map(toHelpCategory) });
}));

adminHelpRouter.post('/categories', route(async (req, res) => {
  const data = helpCategoryInputSchema.parse(req.body);
  res.status(201).json(toHelpCategory(await createHelpCategory(data)));
}));

adminHelpRouter.patch('/categories/:id', route(async (req, res) => {
  res.json(toHelpCategory(await updateHelpCategory(req.params.id, req.body)));
}));

adminHelpRouter.delete('/categories/:id', route(async (req, res) => {
  await deleteHelpCategory(req.params.id);
  res.json({ ok: true });
}));

// --- Articles ---

adminHelpRouter.get('/categories/:catId/articles', route(async (req, res) => {
  const rows = await listHelpArticles(req.params.catId);
  res.json({ items: rows.map(toHelpArticle) });
}));

adminHelpRouter.post('/categories/:catId/articles', route(async (req, res) => {
  res.status(201).json(toHelpArticle(await createHelpArticle(req.params.catId, req.body)));
}));

adminHelpRouter.patch('/categories/:catId/articles/:id', route(async (req, res) => {
  res.json(toHelpArticle(await updateHelpArticle(req.params.catId, req.params.id, req.body)));
}));

adminHelpRouter.delete('/categories/:catId/articles/:id', route(async (req, res) => {
  await deleteHelpArticle(req.params.catId, req.params.id);
  res.json({ ok: true });
}));
