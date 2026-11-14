import { Router } from 'express';
import { route } from '../../shared/http/async-route.js';
import { requireOwner } from '../../shared/middleware/auth.middleware.js';
import { toAdminOrder } from './order.mapper.js';
import { addNoteSchema, advanceOrderSchema, cancelOrderSchema, codCollectionSchema, refundOrderSchema, updateTrackingSchema } from './order.schema.js';
import { addOrderNote, advanceOrder, cancelOrder, getOrderById, listOrders, markOrderPaid, recordCodCollection, refundOrder, updateOrderTracking } from './order.service.js';

// Owner-only order management (rules and workflows live in order.service.ts).

export const adminOrdersRouter = Router();
adminOrdersRouter.use(requireOwner);

adminOrdersRouter.get(
  '/',
  route(async (req, res) => {
    const q = String(req.query.q ?? '').trim().toLowerCase();
    const status = String(req.query.status ?? '').trim();
    const { rows, extras } = await listOrders({ q, status });
    res.json({ items: rows.map((r) => toAdminOrder(r, extras)), total: rows.length });
  }),
);

adminOrdersRouter.get(
  '/:id',
  route(async (req, res) => {
    const { row, extras } = await getOrderById(req.params.id);
    res.json(toAdminOrder(row, extras));
  }),
);

adminOrdersRouter.patch(
  '/:id/advance',
  route(async (req, res) => {
    const input = advanceOrderSchema.parse(req.body);
    res.json(toAdminOrder(await advanceOrder(req.params.id, input)));
  }),
);

adminOrdersRouter.patch(
  '/:id/tracking',
  route(async (req, res) => {
    const input = updateTrackingSchema.parse(req.body);
    res.json(toAdminOrder(await updateOrderTracking(req.params.id, input)));
  }),
);

adminOrdersRouter.post(
  '/:id/cancel',
  route(async (req, res) => {
    const input = cancelOrderSchema.parse(req.body);
    res.json(toAdminOrder(await cancelOrder(req.params.id, input, req.owner!.email)));
  }),
);

adminOrdersRouter.post(
  '/:id/refund',
  route(async (req, res) => {
    const input = refundOrderSchema.parse(req.body);
    res.json(toAdminOrder(await refundOrder(req.params.id, input)));
  }),
);

adminOrdersRouter.post(
  '/:id/mark-paid',
  route(async (req, res) => {
    res.json(toAdminOrder(await markOrderPaid(req.params.id)));
  }),
);

adminOrdersRouter.post(
  '/:id/record-cod-collection',
  route(async (req, res) => {
    const input = codCollectionSchema.parse(req.body);
    res.json(toAdminOrder(await recordCodCollection(req.params.id, input)));
  }),
);

adminOrdersRouter.post(
  '/:id/notes',
  route(async (req, res) => {
    const input = addNoteSchema.parse(req.body);
    res.json(toAdminOrder(await addOrderNote(req.params.id, input, req.owner!.email)));
  }),
);
