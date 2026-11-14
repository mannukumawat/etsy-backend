import { Router } from 'express';
import { route } from '../../shared/http/async-route.js';
import { requireCustomer } from '../../shared/middleware/customer-auth.middleware.js';
import { addUpiSchema } from './upi.schema.js';
import { addUpiId, listUpiIds, removeUpiId } from './upi.service.js';

export const customerUpiRouter = Router();
customerUpiRouter.use(requireCustomer);

customerUpiRouter.get('/', route(async (req, res) => {
  const items = await listUpiIds(req.customer!.sub);
  res.json({ items });
}));

customerUpiRouter.post('/', route(async (req, res) => {
  const input = addUpiSchema.parse(req.body);
  const item = await addUpiId(req.customer!.sub, input);
  res.status(201).json(item);
}));

customerUpiRouter.delete('/:id', route(async (req, res) => {
  await removeUpiId(req.customer!.sub, req.params.id);
  res.json({ ok: true });
}));
