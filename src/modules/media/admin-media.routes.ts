import { Router } from 'express';
import { route } from '../../shared/http/async-route.js';
import { requireOwner } from '../../shared/middleware/auth.middleware.js';
import { toAdminMedia } from './media.mapper.js';
import { mediaUploadSchema, mediaUrlImportSchema } from './media.schema.js';
import { importMediaFromUrl, listMedia, uploadMedia } from './media.service.js';

export const adminMediaRouter = Router();
// Every route below requires the owner — including GET, which exposes the full upload inventory
// (filenames, alt text, upload history) for images that may not be public yet.
adminMediaRouter.use(requireOwner);

adminMediaRouter.get(
  '/',
  route(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const rows = await listMedia(q);
    res.json({ items: rows.map(toAdminMedia) });
  }),
);

adminMediaRouter.post(
  '/',
  route(async (req, res) => {
    const input = mediaUploadSchema.parse(req.body);
    const row = await uploadMedia(input);
    res.status(201).json(toAdminMedia(row));
  }),
);

adminMediaRouter.post(
  '/from-url',
  route(async (req, res) => {
    const input = mediaUrlImportSchema.parse(req.body);
    const row = await importMediaFromUrl(input);
    res.status(201).json(toAdminMedia(row));
  }),
);
