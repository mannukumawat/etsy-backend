import { Router } from 'express';
import { route } from '../../shared/http/async-route.js';
import { requireOwner } from '../../shared/middleware/auth.middleware.js';
import { toAdminHomepage, toAdminPageDoc } from './content.mapper.js';
import { homepageContentSchema, pageContentSchema } from './content.schema.js';
import {
  assertPageKey,
  discardHomepageDraft,
  discardPageDraft,
  getHomepageDraft,
  getPage,
  listPages,
  publishHomepage,
  publishPage,
  saveHomepageDraft,
  savePageDraft,
} from './content.service.js';

export const contentRouter = Router();

contentRouter.use(requireOwner);

// --- homepage -------------------------------------------------------------------------------------

contentRouter.get(
  '/homepage',
  route(async (_req, res) => {
    res.json(toAdminHomepage(await getHomepageDraft()));
  }),
);

contentRouter.put(
  '/homepage',
  route(async (req, res) => {
    const input = homepageContentSchema.parse(req.body);
    res.json(toAdminHomepage(await saveHomepageDraft(input, req.owner!.email)));
  }),
);

contentRouter.post(
  '/homepage/publish',
  route(async (req, res) => {
    res.json(toAdminHomepage(await publishHomepage(req.owner!.email)));
  }),
);

contentRouter.post(
  '/homepage/discard',
  route(async (req, res) => {
    res.json(toAdminHomepage(await discardHomepageDraft(req.owner!.email)));
  }),
);

// --- pages ----------------------------------------------------------------------------------------

contentRouter.get(
  '/pages',
  route(async (_req, res) => {
    const rows = await listPages();
    res.json({ items: rows.map(toAdminPageDoc) });
  }),
);

contentRouter.get(
  '/pages/:key',
  route(async (req, res) => {
    assertPageKey(req.params.key);
    res.json(toAdminPageDoc(await getPage(req.params.key)));
  }),
);

contentRouter.put(
  '/pages/:key',
  route(async (req, res) => {
    assertPageKey(req.params.key);
    const input = pageContentSchema.parse(req.body);
    res.json(toAdminPageDoc(await savePageDraft(req.params.key, input, req.owner!.email)));
  }),
);

contentRouter.post(
  '/pages/:key/publish',
  route(async (req, res) => {
    assertPageKey(req.params.key);
    res.json(toAdminPageDoc(await publishPage(req.params.key, req.owner!.email)));
  }),
);

contentRouter.post(
  '/pages/:key/discard',
  route(async (req, res) => {
    assertPageKey(req.params.key);
    res.json(toAdminPageDoc(await discardPageDraft(req.params.key, req.owner!.email)));
  }),
);
