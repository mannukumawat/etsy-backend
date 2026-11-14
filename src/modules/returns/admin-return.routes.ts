import { Router, type Request } from 'express';
import { route } from '../../shared/http/async-route.js';
import { requireOwner } from '../../shared/middleware/auth.middleware.js';
import {
  addReturnNote, approveReturn, arrangeReturnPickup, getReturnDetail, inspectReturn, listReturns, processReturnRefund,
  receiveReturn, recordReturnShipping, rejectReturn,
} from './admin-return.service.js';
import { toAdminReturn, toAdminReturnDetail, toAdminReturnListItem } from './return.mapper.js';
import {
  addReturnNoteSchema, approveReturnSchema, arrangePickupSchema, inspectReturnSchema, processReturnRefundSchema,
  receiveReturnSchema, recordReturnShippingSchema, rejectReturnSchema,
} from './return.schema.js';

const ownerActor = (req: Request) => ({ id: req.owner!.sub, email: req.owner!.email });

export const adminReturnsRouter = Router();
adminReturnsRouter.use(requireOwner);

// GET / — list with filters + pagination
adminReturnsRouter.get(
  '/',
  route(async (req, res) => {
    const status = String(req.query.status ?? '').trim();
    const orderId = String(req.query.orderId ?? '').trim();
    const q = String(req.query.q ?? '').trim().toLowerCase();
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10));

    const { rows, total, pageCount, statusCounts } = await listReturns({ status, orderId, q, page });
    res.json({
      items: rows.map(toAdminReturnListItem),
      total,
      page,
      pageCount,
      statusCounts,
    });
  }),
);

// GET /:id — detail
adminReturnsRouter.get(
  '/:id',
  route(async (req, res) => {
    const { row, events, refund, order, line } = await getReturnDetail(req.params.id);
    res.json(toAdminReturnDetail(row, events, refund, order, line));
  }),
);

// PATCH /:id/approve
adminReturnsRouter.patch(
  '/:id/approve',
  route(async (req, res) => {
    const input = approveReturnSchema.parse(req.body);
    const { row, events, refund } = await approveReturn(req.params.id, input, ownerActor(req));
    res.json(toAdminReturn(row!, events, refund));
  }),
);

// PATCH /:id/reject
adminReturnsRouter.patch(
  '/:id/reject',
  route(async (req, res) => {
    const input = rejectReturnSchema.parse(req.body);
    const { row, events, refund } = await rejectReturn(req.params.id, input, ownerActor(req));
    res.json(toAdminReturn(row!, events, refund));
  }),
);

// PATCH /:id/arrange-pickup
adminReturnsRouter.patch(
  '/:id/arrange-pickup',
  route(async (req, res) => {
    const input = arrangePickupSchema.parse(req.body);
    const { row, events, refund } = await arrangeReturnPickup(req.params.id, input, ownerActor(req));
    res.json(toAdminReturn(row!, events, refund));
  }),
);

// PATCH /:id/shipping — customer self-ships
adminReturnsRouter.patch(
  '/:id/shipping',
  route(async (req, res) => {
    const input = recordReturnShippingSchema.parse(req.body);
    const { row, events, refund } = await recordReturnShipping(req.params.id, input, ownerActor(req));
    res.json(toAdminReturn(row!, events, refund));
  }),
);

// PATCH /:id/receive
adminReturnsRouter.patch(
  '/:id/receive',
  route(async (req, res) => {
    const input = receiveReturnSchema.parse(req.body);
    const { row, events, refund } = await receiveReturn(req.params.id, input, ownerActor(req));
    res.json(toAdminReturn(row!, events, refund));
  }),
);

// PATCH /:id/inspect
adminReturnsRouter.patch(
  '/:id/inspect',
  route(async (req, res) => {
    const input = inspectReturnSchema.parse(req.body);
    const { row, events, refund } = await inspectReturn(req.params.id, input, ownerActor(req));
    res.json(toAdminReturn(row!, events, refund));
  }),
);

// POST /:id/refund
adminReturnsRouter.post(
  '/:id/refund',
  route(async (req, res) => {
    const input = processReturnRefundSchema.parse(req.body);
    const { row, events, refund } = await processReturnRefund(req.params.id, input, ownerActor(req));
    res.json(toAdminReturn(row!, events, refund));
  }),
);

// POST /:id/notes
adminReturnsRouter.post(
  '/:id/notes',
  route(async (req, res) => {
    const input = addReturnNoteSchema.parse(req.body);
    const { row, events, refund } = await addReturnNote(req.params.id, input, ownerActor(req));
    res.json(toAdminReturn(row!, events, refund));
  }),
);
