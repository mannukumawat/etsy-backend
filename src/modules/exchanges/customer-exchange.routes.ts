import { Router } from 'express';
import { route } from '../../shared/http/async-route.js';
import { requireCustomer } from '../../shared/middleware/customer-auth.middleware.js';
import { toPublicExchange } from './exchange.mapper.js';
import { createExchangeSchema } from './exchange.schema.js';
import { getCustomerExchange, listCustomerExchanges, requestExchange, withdrawExchange } from './exchange.service.js';

export const customerExchangesRouter = Router();
customerExchangesRouter.use(requireCustomer);

// POST / — create exchange request
customerExchangesRouter.post(
  '/',
  route(async (req, res) => {
    const input = createExchangeSchema.parse(req.body);
    const { row, events } = await requestExchange(req.customer!.sub, input);
    res.status(201).json(toPublicExchange(row!, events));
  }),
);

// GET / — list customer's exchanges
customerExchangesRouter.get(
  '/',
  route(async (req, res) => {
    const rows = await listCustomerExchanges(req.customer!.sub);
    res.json({ items: rows.map(r => toPublicExchange(r)) });
  }),
);

// GET /:ref — get by reference
customerExchangesRouter.get(
  '/:ref',
  route(async (req, res) => {
    const { row, events } = await getCustomerExchange(req.customer!.sub, req.params.ref);
    res.json(toPublicExchange(row, events));
  }),
);

// DELETE /:ref — withdraw
customerExchangesRouter.delete(
  '/:ref',
  route(async (req, res) => {
    const reference = await withdrawExchange(req.customer!.sub, req.params.ref);
    res.json({ ok: true, reference });
  }),
);
