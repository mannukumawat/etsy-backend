import { Router } from 'express';
import { route } from '../../shared/http/async-route.js';
import { requireOwner } from '../../shared/middleware/auth.middleware.js';
import { CONTACT_STATUSES, contactUpdateSchema } from './contact.schema.js';
import { deleteContactMessage, findContactMessageOrThrow, listContactMessages, openContactMessage, updateContactMessage } from './contact.service.js';

export const adminContactsRouter = Router();
adminContactsRouter.use(requireOwner);

// GET /api/admin/contacts?status=unread&page=1
adminContactsRouter.get(
  '/',
  route(async (req, res) => {
    const status = typeof req.query.status === 'string' && (CONTACT_STATUSES as readonly string[]).includes(req.query.status) ? req.query.status : null;
    const page = Math.max(1, Number(req.query.page) || 1);
    res.json(await listContactMessages({ status, page }));
  }),
);

// GET /api/admin/contacts/:id
adminContactsRouter.get(
  '/:id',
  route(async (req, res) => {
    res.json(await openContactMessage(req.params.id));
  }),
);

// PATCH /api/admin/contacts/:id
adminContactsRouter.patch(
  '/:id',
  route(async (req, res) => {
    // An unknown id answers 404 before the body is validated (400).
    const row = await findContactMessageOrThrow(req.params.id);
    const input = contactUpdateSchema.parse(req.body);
    res.json(await updateContactMessage(row, input));
  }),
);

// DELETE /api/admin/contacts/:id
adminContactsRouter.delete(
  '/:id',
  route(async (req, res) => {
    await deleteContactMessage(req.params.id);
    res.json({ ok: true });
  }),
);
