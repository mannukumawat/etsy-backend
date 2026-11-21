import { Router } from 'express';
import { route } from '../../shared/http/async-route.js';
import { requireOwner } from '../../shared/middleware/auth.middleware.js';
import { parsePage, parsePageSize } from '../../shared/utils/pagination.js';
import { emitNotificationEvent } from '../../shared/events/notification-events.js';
import { toAdminOrder } from './order.mapper.js';
import { addNoteSchema, advanceOrderSchema, cancelOrderSchema, markOrderPaidSchema, refundOrderSchema, updateTrackingSchema } from './order.schema.js';
import { addOrderNote, advanceOrder, cancelOrder, getOrderById, listOrders, markOrderPaid, refundOrder, restockCancelledOrder, updateOrderTracking, type OrderListSort } from './order.service.js';
import { listRefundsForOrders, verifyManualRefund } from './refund.service.js';

// Owner-only order management (rules and workflows live in order.service.ts).

export const adminOrdersRouter = Router();
adminOrdersRouter.use(requireOwner);

const ORDER_SORTS: OrderListSort[] = ['date', 'total', 'number'];

adminOrdersRouter.get(
  '/',
  route(async (req, res) => {
    const sortRaw = String(req.query.sort ?? 'date');
    const sort: OrderListSort = (ORDER_SORTS as string[]).includes(sortRaw) ? (sortRaw as OrderListSort) : 'date';
    const { rows, extras, refunds, total, page, pageSize, pageCount } = await listOrders({
      q: String(req.query.q ?? '').trim(),
      // `fulfilment` is the admin UI's filter key; `status` stays accepted for older callers.
      status: String(req.query.fulfilment ?? req.query.status ?? '').trim(),
      payment: String(req.query.payment ?? '').trim(),
      currency: String(req.query.currency ?? '').trim(),
      customer: String(req.query.customer ?? '').trim(),
      from: String(req.query.from ?? '').trim(),
      to: String(req.query.to ?? '').trim(),
      pending: req.query.pending === '1',
      paidOnly: req.query.paidOnly === '1',
      sort,
      dir: req.query.dir === 'asc' ? 'asc' : 'desc',
      page: parsePage(req.query.page),
      pageSize: parsePageSize(req.query.pageSize),
    });
    res.json({ items: rows.map((r) => toAdminOrder(r, extras, refunds.get(r.id) ?? [])), total, page, pageSize, pageCount });
  }),
);

adminOrdersRouter.get(
  '/:id',
  route(async (req, res) => {
    const { row, extras, refunds } = await getOrderById(req.params.id);
    res.json(toAdminOrder(row, extras, refunds));
  }),
);

adminOrdersRouter.patch(
  '/:id/advance',
  route(async (req, res) => {
    const input = advanceOrderSchema.parse(req.body);
    const order = await advanceOrder(req.params.id, input);
    const mapped = toAdminOrder(order);
    res.json(mapped);

    // Emit notification events after responding (fire-and-forget).
    const baseFields = {
      orderId: order.id,
      orderNumber: order.number,
      customerId: order.customerId,
      customerEmail: order.customerEmail,
    };
    if (input.to === 'shipped') {
      void emitNotificationEvent({
        type: 'order.shipped',
        ...baseFields,
        carrier: input.carrier,
        trackingNumber: input.trackingNumber,
      });
    } else if (input.to === 'delivered') {
      void emitNotificationEvent({ type: 'order.delivered', ...baseFields });
    }
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
    const order = await cancelOrder(req.params.id, input, req.owner!.email);
    const refunds = await listRefundsForOrders([order.id]);
    res.json(toAdminOrder(order, undefined, refunds.get(order.id) ?? []));
    void emitNotificationEvent({
      type: 'order.cancelled',
      orderId: order.id,
      orderNumber: order.number,
      customerId: order.customerId,
      customerEmail: order.customerEmail,
    });
  }),
);

/** L-I6: restock a cancelled order that was cancelled without restock. */
adminOrdersRouter.post(
  '/:id/restock',
  route(async (req, res) => {
    const order = await restockCancelledOrder(req.params.id, req.owner!.email);
    const refunds = await listRefundsForOrders([order.id]);
    res.json(toAdminOrder(order, undefined, refunds.get(order.id) ?? []));
  }),
);

adminOrdersRouter.post(
  '/:id/refund',
  route(async (req, res) => {
    const input = refundOrderSchema.parse(req.body);
    const order = await refundOrder(req.params.id, input, req.owner!.email);
    const refunds = await listRefundsForOrders([order.id]);
    res.json(toAdminOrder(order, undefined, refunds.get(order.id) ?? []));
  }),
);

/** Verify a pending manual (bank/UPI) refund: only now do the order totals move. */
adminOrdersRouter.post(
  '/:id/refunds/:refundId/verify',
  route(async (req, res) => {
    await verifyManualRefund(req.params.refundId);
    const { row, extras, refunds } = await getOrderById(req.params.id);
    res.json(toAdminOrder(row, extras, refunds));
  }),
);

/** M5: marking paid requires a payment reference, or a forced manual reconciliation with an audit note. */
adminOrdersRouter.post(
  '/:id/mark-paid',
  route(async (req, res) => {
    const input = markOrderPaidSchema.parse(req.body ?? {});
    res.json(toAdminOrder(await markOrderPaid(req.params.id, input, req.owner!.email)));
  }),
);

adminOrdersRouter.post(
  '/:id/notes',
  route(async (req, res) => {
    const input = addNoteSchema.parse(req.body);
    res.json(toAdminOrder(await addOrderNote(req.params.id, input, req.owner!.email)));
  }),
);
