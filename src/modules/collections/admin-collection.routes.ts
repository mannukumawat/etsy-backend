import { Router } from 'express';
import { route } from '../../shared/http/async-route.js';
import { requireOwner } from '../../shared/middleware/auth.middleware.js';
import { toAdminCollection } from './collection.mapper.js';
import { collectionInputSchema, collectionStatusSchema } from './collection.schema.js';
import {
  changeCollectionStatus,
  createCollection,
  deleteCollection,
  getCollection,
  getCollectionOrThrow,
  listCollections,
  updateCollection,
} from './collection.service.js';

export const collectionsRouter = Router();

collectionsRouter.use(requireOwner);

collectionsRouter.get(
  '/',
  route(async (_req, res) => {
    const rows = await listCollections();
    res.json({ items: rows.map(toAdminCollection) });
  }),
);

collectionsRouter.get(
  '/:id',
  route(async (req, res) => {
    res.json(toAdminCollection(await getCollection(req.params.id)));
  }),
);

collectionsRouter.post(
  '/',
  route(async (req, res) => {
    const input = collectionInputSchema.parse(req.body);
    res.status(201).json(toAdminCollection(await createCollection(input)));
  }),
);

collectionsRouter.put(
  '/:id',
  route(async (req, res) => {
    // The collection must exist (404) before the body is validated (400).
    const existing = await getCollectionOrThrow(req.params.id);
    const input = collectionInputSchema.parse(req.body);
    res.json(toAdminCollection(await updateCollection(existing.id, input)));
  }),
);

collectionsRouter.patch(
  '/:id/status',
  route(async (req, res) => {
    const { status } = collectionStatusSchema.parse(req.body);
    res.json(toAdminCollection(await changeCollectionStatus(req.params.id, status)));
  }),
);

collectionsRouter.delete(
  '/:id',
  route(async (req, res) => {
    await deleteCollection(req.params.id);
    res.status(204).end();
  }),
);
