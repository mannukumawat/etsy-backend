import { Router } from 'express';
import { route } from '../../shared/http/async-route.js';
import { requireCustomer } from '../../shared/middleware/customer-auth.middleware.js';
import { toPublicReturn } from './return.mapper.js';
import { createReturnSchema } from './return.schema.js';
import { getCustomerReturn, listCustomerReturns, requestReturn, withdrawReturn } from './return.service.js';

// Customer-facing return requests, mounted at /api/customer/returns.
// All endpoints require an authenticated customer session.

export const customerReturnsRouter = Router();
customerReturnsRouter.use(requireCustomer);

customerReturnsRouter.post(
  '/',
  route(async (req, res) => {
    const input = createReturnSchema.parse(req.body);
    const { row, events, refund } = await requestReturn(req.customer!.sub, input);
    res.status(201).json(toPublicReturn(row!, events, refund));
  }),
);

customerReturnsRouter.get(
  '/',
  route(async (req, res) => {
    const rows = await listCustomerReturns(req.customer!.sub);
    res.json({ items: rows.map(r => toPublicReturn(r)) });
  }),
);

customerReturnsRouter.get(
  '/:ref',
  route(async (req, res) => {
    const { row, events, refund } = await getCustomerReturn(req.customer!.sub, req.params.ref);
    res.json(toPublicReturn(row, events, refund));
  }),
);

customerReturnsRouter.delete(
  '/:ref',
  route(async (req, res) => {
    const reference = await withdrawReturn(req.customer!.sub, req.params.ref);
    res.json({ ok: true, reference });
  }),
);
