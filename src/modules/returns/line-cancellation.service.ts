import { prisma } from '../../shared/database/prisma.js';
import { badRequest, conflict, notFound } from '../../shared/errors/http-error.js';
import type { CancelLineInput } from './return.schema.js';

// Customer-initiated cancellation of (part of) an order line before the order ships. Raw SQL is used
// for the order_lines.cancelled_qty column, which lives outside the Prisma model (see migrate-returns.ts).

/** Cancels `input.qty` units of a line, restores their stock and, when nothing is left to ship, cancels the whole order. */
export async function cancelOrderLine(customerId: string, orderId: string, lineId: string, input: CancelLineInput) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, customerId, customerKind: 'account' },
  });
  if (!order) throw notFound('Order not found.');
  if (!['unfulfilled', 'processing'].includes(order.fulfilmentStatus)) {
    throw conflict('Items can only be cancelled before the order ships. For shipped/delivered items, request a return instead.');
  }

  const lines = await prisma.$queryRawUnsafe<Array<{
    id: string; variant_id: string; sku: string; quantity: number;
    cancelled_qty: number; unit_price: number; line_total: number;
    name_en: string; name_hi: string; variant_label_en: string;
  }>>(
    `SELECT id, variantId AS variant_id, sku, quantity, cancelled_qty, unitPrice AS unit_price, lineTotal AS line_total, nameEn AS name_en, nameHi AS name_hi, variantLabelEn AS variant_label_en FROM order_lines WHERE id = ? AND orderId = ?`,
    lineId, orderId,
  );
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

    // Restore stock
    const variant = await tx.productVariant.findUnique({
      where: { id: line.variant_id },
      select: { stock: true, product: { select: { id: true, nameEn: true, nameHi: true } } },
    });
    if (variant) {
      const before = variant.stock;
      await tx.productVariant.update({ where: { id: line.variant_id }, data: { stock: before + input.qty } });
      await tx.inventoryAdjustment.create({
        data: {
          productId: variant.product.id,
          variantId: line.variant_id,
          sku: line.sku,
          productNameEn: variant.product.nameEn,
          productNameHi: variant.product.nameHi,
          variantLabel: line.variant_label_en,
          before,
          after: before + input.qty,
          delta: input.qty,
          reason: 'order_cancelled',
          note: `Item cancellation: order ${order.number}, qty ${input.qty}${input.note ? '. ' + input.note : ''}`,
          actor: `customer:${customerId}`,
        },
      });
    }

    // Add order event
    await tx.orderEvent.create({
      data: {
        orderId,
        type: 'cancelled',
        message: `Item cancelled: ${line.name_en}${line.variant_label_en ? ' (' + line.variant_label_en + ')' : ''} × ${input.qty}. Reason: ${input.reason}${allCancelled ? '' : ' (partial)'}`,
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
          message: `Cancelled: every item was cancelled by the customer.${order.paymentStatus === 'paid' ? ' Payment was already received, so a refund is due.' : ''}`,
          actor: 'customer',
        },
      });
    }
  });

  return { cancelledQty, allCancelled, orderCancelled };
}
