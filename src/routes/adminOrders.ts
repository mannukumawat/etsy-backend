import { Router } from 'express';
import { requireOwner } from '../auth.js';
import { prisma } from '../db.js';
import { badRequest, conflict, notFound, route } from '../http.js';
import { ORDER_INCLUDE, toAdminOrder } from '../mappers.js';
import { loadLineExtras } from '../orderLineExtras.js';
import {
  addNoteSchema,
  advanceOrderSchema,
  cancelOrderSchema,
  codCollectionSchema,
  refundOrderSchema,
  updateTrackingSchema,
} from '../validation.js';

// Owner-only order management. The fulfilment state machine (unfulfilled -> processing -> shipped ->
// delivered, with cancel only before shipping) and the payment rules (advance only while paid, cancel
// restocks exactly once) mirror admin/src/utils/orderRules.ts exactly.

export const adminOrdersRouter = Router();
adminOrdersRouter.use(requireOwner);

const FULFILMENT_ORDER = ['unfulfilled', 'processing', 'shipped', 'delivered'] as const;

adminOrdersRouter.get(
  '/',
  route(async (req, res) => {
    const q = String(req.query.q ?? '').trim().toLowerCase();
    const status = String(req.query.status ?? '').trim();
    const rows = await prisma.order.findMany({
      where: {
        ...(status ? { fulfilmentStatus: status } : {}),
        ...(q ? { OR: [{ number: { contains: q } }, { customerEmail: { contains: q } }, { customerName: { contains: q } }] } : {}),
      },
      include: ORDER_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    const extras = await loadLineExtras(rows.map((r) => r.id));
    res.json({ items: rows.map((r) => toAdminOrder(r, extras)), total: rows.length });
  }),
);

adminOrdersRouter.get(
  '/:id',
  route(async (req, res) => {
    const row = await prisma.order.findUnique({ where: { id: req.params.id }, include: ORDER_INCLUDE });
    if (!row) throw notFound('Order not found.');
    res.json(toAdminOrder(row, await loadLineExtras([row.id])));
  }),
);

async function loadOrderOr404(id: string) {
  const row = await prisma.order.findUnique({ where: { id } });
  if (!row) throw notFound('Order not found.');
  return row;
}

adminOrdersRouter.patch(
  '/:id/advance',
  route(async (req, res) => {
    const input = advanceOrderSchema.parse(req.body);
    const order = await loadOrderOr404(req.params.id);

    const isCod = order.paymentMethod === 'cod';
    if (!isCod && !['paid', 'partially_refunded'].includes(order.paymentStatus)) {
      throw conflict('This order must be paid before its fulfilment can advance.');
    }
    const currentIndex = FULFILMENT_ORDER.indexOf(order.fulfilmentStatus as (typeof FULFILMENT_ORDER)[number]);
    const targetIndex = FULFILMENT_ORDER.indexOf(input.to as (typeof FULFILMENT_ORDER)[number]);
    if (currentIndex === -1 || targetIndex !== currentIndex + 1) {
      throw badRequest(`Cannot move from "${order.fulfilmentStatus}" to "${input.to}". Advance one step at a time.`, [{ path: 'to', message: 'Invalid transition.' }]);
    }

    const messages: Record<string, string> = {
      processing: 'processing: Order is being prepared.',
      shipped: `shipped: Shipped via ${input.carrier} (${input.trackingNumber}).`,
      delivered: 'delivered: Delivered.',
    };

    const updated = await prisma.order.update({
      where: { id: order.id },
      data: {
        fulfilmentStatus: input.to,
        ...(input.to === 'shipped' ? { carrier: input.carrier, trackingNumber: input.trackingNumber, trackingUrl: input.trackingUrl || null } : {}),
        events: { create: [{ type: 'fulfilment', message: messages[input.to], actor: 'admin' }] },
      },
      include: ORDER_INCLUDE,
    });
    res.json(toAdminOrder(updated));
  }),
);

adminOrdersRouter.patch(
  '/:id/tracking',
  route(async (req, res) => {
    const input = updateTrackingSchema.parse(req.body);
    const order = await loadOrderOr404(req.params.id);
    if (!['shipped', 'delivered'].includes(order.fulfilmentStatus)) {
      throw conflict('Tracking can be edited after the order has shipped.');
    }
    const updated = await prisma.order.update({
      where: { id: order.id },
      data: {
        carrier: input.carrier,
        trackingNumber: input.trackingNumber,
        trackingUrl: input.trackingUrl || null,
        events: { create: [{ type: 'tracking', message: `Tracking updated: ${input.carrier} ${input.trackingNumber}.`, actor: 'admin' }] },
      },
      include: ORDER_INCLUDE,
    });
    res.json(toAdminOrder(updated));
  }),
);

adminOrdersRouter.post(
  '/:id/cancel',
  route(async (req, res) => {
    const input = cancelOrderSchema.parse(req.body);
    const order = await loadOrderOr404(req.params.id);
    if (!['unfulfilled', 'processing'].includes(order.fulfilmentStatus)) {
      throw conflict('An order that has already shipped cannot be cancelled. Use a refund instead.');
    }

    const updated = await prisma.$transaction(async (tx) => {
      const events: Array<{ type: string; message: string; actor: 'admin' }> = [
        { type: 'cancelled', message: `Cancelled: ${input.reason || 'No reason given'}.`, actor: 'admin' },
      ];

      if (input.restock && !order.restocked) {
        const lines = await tx.orderLine.findMany({ where: { orderId: order.id } });
        for (const line of lines) {
          const variant = await tx.productVariant.findUnique({ where: { id: line.variantId }, select: { stock: true, product: { select: { id: true, nameEn: true, nameHi: true } } } });
          if (!variant) continue; // the variant may have since been rebuilt by a product edit; nothing to restock against
          const before = variant.stock;
          const after = before + line.quantity;
          await tx.productVariant.update({ where: { id: line.variantId }, data: { stock: after } });
          await tx.inventoryAdjustment.create({
            data: {
              productId: variant.product.id,
              variantId: line.variantId,
              sku: line.sku,
              productNameEn: variant.product.nameEn,
              productNameHi: variant.product.nameHi,
              variantLabel: line.variantLabelEn,
              before,
              after,
              delta: line.quantity,
              reason: 'order_cancelled',
              note: `Restocked from cancelled order ${order.number}.`,
              actor: req.owner!.email,
            },
          });
        }
      }

      let refundedTotal = order.refundedTotal;
      let paymentStatus = order.paymentStatus;
      const refundable = ['paid', 'partially_refunded'].includes(order.paymentStatus) ? Math.max(0, order.total - order.refundedTotal) : 0;
      if (input.refund && refundable > 0) {
        refundedTotal = order.refundedTotal + refundable;
        paymentStatus = 'refunded';
        events.push({ type: 'refund', message: `Refunded ${refundable} ${order.currency} (cancellation).`, actor: 'admin' });
      }

      return tx.order.update({
        where: { id: order.id },
        data: { fulfilmentStatus: 'cancelled', restocked: input.restock || order.restocked, refundedTotal, paymentStatus, events: { create: events } },
        include: ORDER_INCLUDE,
      });
    });

    res.json(toAdminOrder(updated));
  }),
);

adminOrdersRouter.post(
  '/:id/refund',
  route(async (req, res) => {
    const input = refundOrderSchema.parse(req.body);
    const order = await loadOrderOr404(req.params.id);
    if (!['paid', 'partially_refunded'].includes(order.paymentStatus)) throw conflict('This order has not been paid, so it cannot be refunded.');
    const remaining = order.total - order.refundedTotal;
    if (input.amount > remaining) throw badRequest(`Cannot refund more than the remaining ${remaining} owed.`, [{ path: 'amount', message: 'Too high.' }]);

    const refundedTotal = order.refundedTotal + input.amount;
    const paymentStatus = refundedTotal >= order.total ? 'refunded' : 'partially_refunded';
    const updated = await prisma.order.update({
      where: { id: order.id },
      data: {
        refundedTotal,
        paymentStatus,
        events: { create: [{ type: 'refund', message: `Refunded ${input.amount} ${order.currency}${input.reason ? `: ${input.reason}` : '.'}`, actor: 'admin' }] },
      },
      include: ORDER_INCLUDE,
    });
    res.json(toAdminOrder(updated));
  }),
);

adminOrdersRouter.post(
  '/:id/mark-paid',
  route(async (req, res) => {
    const order = await loadOrderOr404(req.params.id);
    if (order.paymentStatus !== 'unpaid' || order.fulfilmentStatus === 'cancelled') {
      throw conflict('Only an unpaid, non-cancelled order can be marked paid.');
    }
    if (order.paymentMethod === 'cod' && order.fulfilmentStatus !== 'delivered') {
      throw conflict('COD orders can only be marked paid after delivery.');
    }
    const updated = await prisma.order.update({
      where: { id: order.id },
      data: { paymentStatus: 'paid', events: { create: [{ type: 'payment', message: 'Marked as paid (cash on delivery collected).', actor: 'admin' }] } },
      include: ORDER_INCLUDE,
    });
    res.json(toAdminOrder(updated));
  }),
);

adminOrdersRouter.post(
  '/:id/record-cod-collection',
  route(async (req, res) => {
    const input = codCollectionSchema.parse(req.body);
    const order = await prisma.order.findUnique({ where: { id: req.params.id }, include: ORDER_INCLUDE });
    if (!order) throw notFound('Order not found.');
    if (order.paymentMethod !== 'cod') throw conflict('This endpoint is only for COD orders.');
    if (order.paymentStatus !== 'unpaid') throw conflict('Payment has already been recorded for this order.');
    if (order.fulfilmentStatus === 'cancelled') throw conflict('Cannot record collection for a cancelled order.');
    const alreadyRecorded = order.events.some((e) => e.type === 'payment' && e.message.startsWith('COD collected'));
    if (alreadyRecorded) throw conflict('COD collection already recorded for this order.');
    if (input.amount !== order.total) throw badRequest(`Amount must equal the order total (${order.total} ${order.currency}).`, [{ path: 'amount', message: 'Must match order total.' }]);

    const { collector, reference, note } = input;
    const message = `COD collected: ${input.amount} ${order.currency} by ${collector}${reference ? ` (ref: ${reference})` : ''}${note ? `. ${note}` : ''}.`;
    const updated = await prisma.order.update({
      where: { id: order.id },
      data: {
        paymentStatus: 'paid',
        events: { create: [{ type: 'payment', message, actor: 'admin' }] },
      },
      include: ORDER_INCLUDE,
    });
    res.json(toAdminOrder(updated));
  }),
);

adminOrdersRouter.post(
  '/:id/notes',
  route(async (req, res) => {
    const input = addNoteSchema.parse(req.body);
    const order = await loadOrderOr404(req.params.id);
    const updated = await prisma.order.update({
      where: { id: order.id },
      data: { notes: { create: [{ author: req.owner!.email, body: input.body }] } },
      include: ORDER_INCLUDE,
    });
    res.json(toAdminOrder(updated));
  }),
);
