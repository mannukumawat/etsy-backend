import { Router, type Request } from 'express';
import { route } from '../../shared/http/async-route.js';
import { requireOwner } from '../../shared/middleware/auth.middleware.js';
import {
  approveExchange, closeExchange, getExchangeDetail, listExchanges, markExchangeDelivered, rejectExchange, shipExchange,
} from './admin-exchange.service.js';
import { toAdminExchange } from './exchange.mapper.js';
import { approveExchangeSchema, rejectExchangeSchema, shipExchangeSchema } from './exchange.schema.js';

const ownerActor = (req: Request) => ({ id: req.owner!.sub, email: req.owner!.email });

export const adminExchangesRouter = Router();
adminExchangesRouter.use(requireOwner);

// GET / — list all exchanges
adminExchangesRouter.get(
  '/',
  route(async (req, res) => {
    const status = req.query.status as string | undefined;
    const rows = await listExchanges(status);
    res.json({ items: rows.map(r => toAdminExchange(r)) });
  }),
);

// GET /:id — detail
adminExchangesRouter.get(
  '/:id',
  route(async (req, res) => {
    const { row, events } = await getExchangeDetail(req.params.id);
    res.json(toAdminExchange(row, events));
  }),
);

// PATCH /:id/approve
adminExchangesRouter.patch(
  '/:id/approve',
  route(async (req, res) => {
    const input = approveExchangeSchema.parse(req.body);
    const { row, events } = await approveExchange(req.params.id, input, ownerActor(req));
    res.json(toAdminExchange(row!, events));
  }),
);

// PATCH /:id/reject
adminExchangesRouter.patch(
  '/:id/reject',
  route(async (req, res) => {
    const input = rejectExchangeSchema.parse(req.body);
    const { row, events } = await rejectExchange(req.params.id, input, ownerActor(req));
    res.json(toAdminExchange(row!, events));
  }),
);

// PATCH /:id/ship — record replacement shipment
adminExchangesRouter.patch(
  '/:id/ship',
  route(async (req, res) => {
    const input = shipExchangeSchema.parse(req.body);
    const { row, events } = await shipExchange(req.params.id, input, ownerActor(req));
    res.json(toAdminExchange(row!, events));
  }),
);

// PATCH /:id/deliver — mark replacement delivered
adminExchangesRouter.patch(
  '/:id/deliver',
  route(async (req, res) => {
    const { row, events } = await markExchangeDelivered(req.params.id, ownerActor(req));
    res.json(toAdminExchange(row!, events));
  }),
);

// PATCH /:id/close
adminExchangesRouter.patch(
  '/:id/close',
  route(async (req, res) => {
    const { row, events } = await closeExchange(req.params.id, ownerActor(req));
    res.json(toAdminExchange(row!, events));
  }),
);
