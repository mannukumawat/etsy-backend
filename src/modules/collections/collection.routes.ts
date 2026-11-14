import { Router } from 'express';
import { route } from '../../shared/http/async-route.js';
import { getPublishedCollection, listPublishedCollections } from './collection.service.js';

export const publicCollectionsRouter = Router();

publicCollectionsRouter.get(
  '/',
  route(async (_req, res) => {
    res.json({ items: await listPublishedCollections() });
  }),
);

publicCollectionsRouter.get(
  '/:slug',
  route(async (req, res) => {
    res.json(await getPublishedCollection(req.params.slug));
  }),
);
