import { prisma } from '../../shared/database/prisma.js';
import { badRequest, conflict, notFound } from '../../shared/errors/http-error.js';
import { loadLineExtras } from './order-line-extras.service.js';
import { ORDER_INCLUDE } from './order.mapper.js';
import type { AddNoteInput, AdvanceOrderInput, CancelOrderInput, CodCollectionInput, RefundOrderInput, UpdateTrackingInput } from './order.schema.js';

// Owner-only order management. The fulfilment state machine (unfulfilled -> processing -> shipped ->
// delivered, with cancel only before shipping) and the payment rules (advance only while paid, cancel
// restocks exactly once) mirror admin/src/utils/orderRules.ts exactly.

const FULFILMENT_ORDER = ['unfulfilled', 'processing', 'shipped', 'delivered'] as const;

export async function listOrders(query: { q: string; status: string }) {
  const { q, status } = query;
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
  return { rows, extras };
}

export async function getOrderById(id: string) {
  const row = await prisma.order.findUnique({ where: { id }, include: ORDER_INCLUDE });
  if (!row) throw notFound('Order not found.');
  return { row, extras: await loadLineExtras([row.id]) };
}

async function loadOrderOr404(id: string) {
  const row = await prisma.order.findUnique({ where: { id } });
  if (!row) throw notFound('Order not found.');
  return row;
}

export async function advanceOrder(id: string, input: AdvanceOrderInput) {
  const order = await loadOrderOr404(id);

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

  return prisma.order.update({
    where: { id: order.id },
    data: {
      fulfilmentStatus: input.to,
      ...(input.to === 'shipped' ? { carrier: input.carrier, trackingNumber: input.trackingNumber, trackingUrl: input.trackingUrl || null } : {}),
      events: { create: [{ type: 'fulfilment', message: messages[input.to], actor: 'admin' }] },
    },
    include: ORDER_INCLUDE,
  });
}

export async function updateOrderTracking(id: string, input: UpdateTrackingInput) {
  const order = await loadOrderOr404(id);
  if (!['shipped', 'delivered'].includes(order.fulfilmentStatus)) {
    throw conflict('Tracking can be edited after the order has shipped.');
  }
  return prisma.order.update({
    where: { id: order.id },
    data: {
      carrier: input.carrier,
      trackingNumber: input.trackingNumber,
      trackingUrl: input.trackingUrl || null,
      events: { create: [{ type: 'tracking', message: `Tracking updated: ${input.carrier} ${input.trackingNumber}.`, actor: 'admin' }] },
    },
    include: ORDER_INCLUDE,
  });
}

/** Cancels an unshipped order; optionally restocks its lines (exactly once) and refunds what was paid. */
export async function cancelOrder(id: string, input: CancelOrderInput, actorEmail: string) {
  const order = await loadOrderOr404(id);
  if (!['unfulfilled', 'processing'].includes(order.fulfilmentStatus)) {
    throw conflict('An order that has already shipped cannot be cancelled. Use a refund instead.');
  }

  return prisma.$transaction(async (tx) => {
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
            actor: actorEmail,
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
}

export async function refundOrder(id: string, input: RefundOrderInput) {
  const order = await loadOrderOr404(id);
  if (!['paid', 'partially_refunded'].includes(order.paymentStatus)) throw conflict('This order has not been paid, so it cannot be refunded.');
  const remaining = order.total - order.refundedTotal;
  if (input.amount > remaining) throw badRequest(`Cannot refund more than the remaining ${remaining} owed.`, [{ path: 'amount', message: 'Too high.' }]);

  const refundedTotal = order.refundedTotal + input.amount;
  const paymentStatus = refundedTotal >= order.total ? 'refunded' : 'partially_refunded';
  return prisma.order.update({
    where: { id: order.id },
    data: {
      refundedTotal,
      paymentStatus,
      events: { create: [{ type: 'refund', message: `Refunded ${input.amount} ${order.currency}${input.reason ? `: ${input.reason}` : '.'}`, actor: 'admin' }] },
    },
    include: ORDER_INCLUDE,
  });
}

export async function markOrderPaid(id: string) {
  const order = await loadOrderOr404(id);
  if (order.paymentStatus !== 'unpaid' || order.fulfilmentStatus === 'cancelled') {
    throw conflict('Only an unpaid, non-cancelled order can be marked paid.');
  }
  if (order.paymentMethod === 'cod' && order.fulfilmentStatus !== 'delivered') {
    throw conflict('COD orders can only be marked paid after delivery.');
  }
  return prisma.order.update({
    where: { id: order.id },
    data: { paymentStatus: 'paid', events: { create: [{ type: 'payment', message: 'Marked as paid (cash on delivery collected).', actor: 'admin' }] } },
    include: ORDER_INCLUDE,
  });
}

export async function recordCodCollection(id: string, input: CodCollectionInput) {
  const order = await prisma.order.findUnique({ where: { id }, include: ORDER_INCLUDE });
  if (!order) throw notFound('Order not found.');
  if (order.paymentMethod !== 'cod') throw conflict('This endpoint is only for COD orders.');
  if (order.paymentStatus !== 'unpaid') throw conflict('Payment has already been recorded for this order.');
  if (order.fulfilmentStatus === 'cancelled') throw conflict('Cannot record collection for a cancelled order.');
  const alreadyRecorded = order.events.some((e) => e.type === 'payment' && e.message.startsWith('COD collected'));
  if (alreadyRecorded) throw conflict('COD collection already recorded for this order.');
  if (input.amount !== order.total) throw badRequest(`Amount must equal the order total (${order.total} ${order.currency}).`, [{ path: 'amount', message: 'Must match order total.' }]);

  const { collector, reference, note } = input;
  const message = `COD collected: ${input.amount} ${order.currency} by ${collector}${reference ? ` (ref: ${reference})` : ''}${note ? `. ${note}` : ''}.`;
  return prisma.order.update({
    where: { id: order.id },
    data: {
      paymentStatus: 'paid',
      events: { create: [{ type: 'payment', message, actor: 'admin' }] },
    },
    include: ORDER_INCLUDE,
  });
}

export async function addOrderNote(id: string, input: AddNoteInput, authorEmail: string) {
  const order = await loadOrderOr404(id);
  return prisma.order.update({
    where: { id: order.id },
    data: { notes: { create: [{ author: authorEmail, body: input.body }] } },
    include: ORDER_INCLUDE,
  });
}
