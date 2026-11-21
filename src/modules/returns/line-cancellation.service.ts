import type { Prisma } from '@prisma/client';
import { prisma } from '../../shared/database/prisma.js';
import { badRequest, conflict, notFound } from '../../shared/errors/http-error.js';
import { issueOrderRefund, type OrderLike, type RefundMethod } from '../orders/refund.service.js';
import type { CancelLineInput } from './return.schema.js';

// Customer-initiated cancellation of (part of) an order line before the order ships.
// C4: a paid order's cancelled lines are REFUNDED here, not just noted — the refund
// runs through the shared refund service (gateway for card/UPI, wallet credit for
// wallet-paid orders) and the order event states the refund id and amount.

interface OrderLineRow {
  id: string;
  variant_id: string;
  sku: string;
  quantity: number;
  cancelled_qty: number;
  unit_price: number;
  line_total: number;
  name_en: string;
  name_hi: string;
  variant_label_en: string;
}

async function loadOrderLines(orderId: string, lineId?: string): Promise<OrderLineRow[]> {
  const where = lineId ? 'AND id = ?' : '';
  const params = lineId ? [orderId, lineId] : [orderId];
  return prisma.$queryRawUnsafe<OrderLineRow[]>(
    `SELECT id, variantId AS variant_id, sku, quantity, cancelled_qty, unitPrice AS unit_price, lineTotal AS line_total, nameEn AS name_en, nameHi AS name_hi, variantLabelEn AS variant_label_en FROM order_lines WHERE orderId = ? ${where}`,
    ...params,
  );
}

async function loadAccountOrder(customerId: string, orderId: string) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, customerId, customerKind: 'account' },
  });
  if (!order) throw notFound('Order not found.');
  if (!['unfulfilled', 'processing'].includes(order.fulfilmentStatus)) {
    throw conflict('Items can only be cancelled before the order ships. For shipped/delivered items, request a return instead.');
  }
  return order;
}

/** Restores `qty` units of a line to stock inside the caller's transaction. Returns true when the variant no longer exists (units could not be restocked). */
async function restockLine(
  tx: Prisma.TransactionClient,
  line: OrderLineRow,
  qty: number,
  actor: string,
  orderNumber: string,
  noteSuffix: string,
): Promise<boolean> {
  const variant = await tx.productVariant.findUnique({
    where: { id: line.variant_id },
    select: { stock: true, product: { select: { id: true, nameEn: true, nameHi: true } } },
  });
  if (!variant) return true; // M-I3: the variant is gone — the caller records it on the timeline.
  const updated = await tx.productVariant.updateMany({ where: { id: line.variant_id }, data: { stock: { increment: qty } } });
  if (updated.count === 0) return true;
  const afterRow = await tx.productVariant.findUnique({ where: { id: line.variant_id }, select: { stock: true } });
  const after = afterRow?.stock ?? variant.stock + qty;
  await tx.inventoryAdjustment.create({
    data: {
      productId: variant.product.id,
      variantId: line.variant_id,
      sku: line.sku,
      productNameEn: variant.product.nameEn,
      productNameHi: variant.product.nameHi,
      variantLabel: line.variant_label_en,
      before: after - qty,
      after,
      delta: qty,
      reason: 'order_cancelled',
      note: `Item cancellation: order ${orderNumber}, qty ${qty}${noteSuffix}`,
      actor,
    },
  });
  return false;
}

export interface LineRefundResult {
  refundId: string;
  amount: number;
  method: RefundMethod;
  status: string;
}

export interface CancellationRefundOutcome {
  refund: LineRefundResult | null;
  /** Set when no automatic refund was possible (or the gateway refused it) — the caller records it on the timeline so the owner follows up. */
  error: string | null;
}

/**
 * Refunds the cancelled value of a paid order through the shared refund service.
 * Runs AFTER the cancellation transaction commits (issueOrderRefund owns its own
 * transaction, so it cannot run inside it). The caller records the outcome — refund
 * id + amount, or the reason no refund could be issued — as an order event, so a
 * cancellation is never left saying only "a refund is due".
 */
async function refundCancelledLines(
  order: OrderLike,
  amount: number,
  reason: string,
  actorEmail: string,
): Promise<CancellationRefundOutcome> {
  if (amount <= 0) return { refund: null, error: null };
  if (!['paid', 'partially_refunded'].includes(order.paymentStatus)) return { refund: null, error: null };
  let method: RefundMethod;
  if (order.paymentMethod === 'wallet') {
    if (!order.customerId) return { refund: null, error: `Refund of ${amount} ${order.currency} could not be credited: this wallet-paid order has no customer account. The owner must refund it manually.` };
    method = 'store_credit';
  } else if (order.paymentReference) {
    method = 'original';
  } else {
    return { refund: null, error: `Refund of ${amount} ${order.currency} could not be sent automatically: no payment reference is stored for this order. The owner must refund it manually.` };
  }
  try {
    const view = await issueOrderRefund(order, { amount, reason, method }, actorEmail);
    return { refund: { refundId: view.id, amount: view.amount, method, status: view.status }, error: null };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { refund: null, error: `Refund of ${amount} ${order.currency} failed (${message}). The owner must refund it manually.` };
  }
}

async function recordRefundOutcome(orderId: string, outcome: CancellationRefundOutcome, label: string): Promise<void> {
  if (outcome.refund) {
    await prisma.orderEvent.create({
      data: {
        orderId,
        type: 'refund',
        message: `Refunded ${outcome.refund.amount} for ${label} (refund ${outcome.refund.refundId}, ${outcome.refund.method}, status ${outcome.refund.status}).`,
        actor: 'customer',
      },
    });
  } else if (outcome.error) {
    await prisma.orderEvent.create({
      data: { orderId, type: 'refund', message: outcome.error, actor: 'customer' },
    });
  }
}

/** Cancels `input.qty` units of a line, restores their stock and, when nothing is left to ship, cancels the whole order. */
export async function cancelOrderLine(customerId: string, orderId: string, lineId: string, input: CancelLineInput) {
  const order = await loadAccountOrder(customerId, orderId);

  const lines = await loadOrderLines(orderId, lineId);
  const line = lines[0];
  if (!line) throw notFound('Order line not found.');

  const cancelledQty = (line.cancelled_qty ?? 0) + input.qty;
  if (cancelledQty > line.quantity) {
    throw badRequest(`Cannot cancel ${input.qty} — only ${line.quantity - (line.cancelled_qty ?? 0)} uncancelled units remain.`);
  }
  const allCancelled = cancelledQty >= line.quantity;
  let orderCancelled = false;

  await prisma.$transaction(async (tx) => {
    // Update cancelled quantity
    await tx.$executeRawUnsafe(
      `UPDATE order_lines SET cancelled_qty = ? WHERE id = ?`,
      cancelledQty, lineId,
    );

    // Restore stock — M-I7: atomic increment, never read-then-write, so a concurrent
    // adjustment cannot be overwritten. The post-update read gives exact before/after.
    const restockSkipped = await restockLine(
      tx, line, input.qty, `customer:${customerId}`, order.number, input.note ? '. ' + input.note : '',
    );

    // Add order event
    await tx.orderEvent.create({
      data: {
        orderId,
        type: 'cancelled',
        message: `Item cancelled: ${line.name_en}${line.variant_label_en ? ' (' + line.variant_label_en + ')' : ''} × ${input.qty}. Reason: ${input.reason}${allCancelled ? '' : ' (partial)'}${restockSkipped ? ` Note: the variant no longer exists, so ${input.qty} unit(s) could not be restocked.` : ''}`,
        actor: 'customer',
      },
    });

    // Nothing left to ship (every unit of every line cancelled) -> the whole order is cancelled.
    const left = await tx.$queryRawUnsafe<Array<{ remaining: number | bigint | null }>>(
      `SELECT COALESCE(SUM(quantity - cancelled_qty), 0) AS remaining FROM order_lines WHERE orderId = ?`,
      orderId,
    );
    if (Number(left[0]?.remaining ?? 1) <= 0) {
      orderCancelled = true;
      await tx.order.update({ where: { id: orderId }, data: { fulfilmentStatus: 'cancelled', restocked: true } });
      await tx.orderEvent.create({
        data: {
          orderId,
          type: 'cancelled',
          message: 'Cancelled: every item was cancelled by the customer.',
          actor: 'customer',
        },
      });
    }
  });

  // C4: refund the cancelled units of a paid order (gateway / wallet credit via the
  // shared refund service). The event states the refund id and amount.
  const refundAmount = line.unit_price * input.qty;
  const outcome = await refundCancelledLines(order, refundAmount, `Cancellation of ${input.qty} × ${line.name_en} in order ${order.number}`, order.customerEmail);
  await recordRefundOutcome(orderId, outcome, `cancelled item ${line.name_en} × ${input.qty}`);

  return { cancelledQty, allCancelled, orderCancelled, refund: outcome.refund, refundError: outcome.error };
}

/**
 * Cancels a whole order from the customer side, through the same per-line path as
 * cancelOrderLine: every remaining unit of every line is cancelled and restocked,
 * the order is cancelled, and a paid order is refunded for the full cancelled value.
 */
export async function cancelEntireOrder(customerId: string, orderId: string, reason?: string) {
  const order = await loadAccountOrder(customerId, orderId);
  const lines = await loadOrderLines(orderId);
  const remaining = lines.filter((l) => (l.quantity - (l.cancelled_qty ?? 0)) > 0);
  if (!remaining.length) throw conflict('This order has no items left to cancel.');

  const refundAmount = remaining.reduce((sum, l) => sum + l.unit_price * (l.quantity - (l.cancelled_qty ?? 0)), 0);
  const unitsCancelled = remaining.reduce((sum, l) => sum + (l.quantity - (l.cancelled_qty ?? 0)), 0);

  await prisma.$transaction(async (tx) => {
    let restockSkipped = false;
    for (const line of remaining) {
      const qty = line.quantity - (line.cancelled_qty ?? 0);
      await tx.$executeRawUnsafe(`UPDATE order_lines SET cancelled_qty = ? WHERE id = ?`, line.quantity, line.id);
      const skipped = await restockLine(tx, line, qty, `customer:${customerId}`, order.number, reason ? `. ${reason}` : '');
      restockSkipped = restockSkipped || skipped;
    }
    await tx.order.update({ where: { id: orderId }, data: { fulfilmentStatus: 'cancelled', restocked: true } });
    await tx.orderEvent.create({
      data: {
        orderId,
        type: 'cancelled',
        message: `Cancelled by the customer: ${remaining.length} item(s), ${unitsCancelled} unit(s).${reason ? ` Reason: ${reason}.` : ''}${restockSkipped ? ' Note: a variant no longer exists, so some unit(s) could not be restocked.' : ''}`,
        actor: 'customer',
      },
    });
  });

  const outcome = await refundCancelledLines(order, refundAmount, `Cancellation of order ${order.number}`, order.customerEmail);
  await recordRefundOutcome(orderId, outcome, `cancelled order ${order.number}`);

  return { orderCancelled: true, linesCancelled: remaining.length, unitsCancelled, refund: outcome.refund, refundError: outcome.error };
}
