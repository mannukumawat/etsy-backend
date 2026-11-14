import { prisma } from '../../shared/database/prisma.js';
import { badRequest, conflict, notFound } from '../../shared/errors/http-error.js';
import { randomHexId } from '../../shared/utils/ids.js';
import { fetchReturnWithDetails } from './return.repository.js';
import type { CreateReturnInput } from './return.schema.js';
import type { ReturnRequestRow } from './return.types.js';

// Customer-side return requests. Raw SQL throughout: the return tables live outside the Prisma model
// (created by migrate-returns.ts).

function generateReturnRef() { return 'RET-' + randomHexId(4).toUpperCase(); }

/**
 * Allocates the amount the customer actually paid across order lines. This includes the line's
 * proportional share of discounts, tax and outbound shipping, so a full return of a single-line
 * order refunds the exact order total rather than only the catalogue price.
 */
export function calculateRefundableAmount(input: {
  orderTotal: number;
  orderSubtotal: number;
  lineTotal: number;
  lineQuantity: number;
  requestedQuantity: number;
}) {
  const lineShare = Math.round((input.lineTotal * input.requestedQuantity) / input.lineQuantity);
  if (input.orderSubtotal <= 0) return Math.min(input.orderTotal, lineShare);
  return Math.min(input.orderTotal, Math.round((input.orderTotal * lineShare) / input.orderSubtotal));
}

async function loadReturnForCustomer(ref: string, customerId: string) {
  const rows = await prisma.$queryRawUnsafe<ReturnRequestRow[]>(
    `SELECT rr.* FROM return_requests rr
     JOIN orders o ON o.id = rr.order_id
     WHERE rr.reference = ? AND o.customerId = ? AND o.customerKind = 'account'`,
    ref, customerId,
  );
  if (!rows[0]) throw notFound('Return request not found.');
  return rows[0];
}

/** Creates a return request for a delivered order line and reserves the returned quantity. */
export async function requestReturn(customerId: string, input: CreateReturnInput) {
  // Verify order belongs to customer and is delivered
  const order = await prisma.order.findFirst({
    where: { id: input.orderId, customerId, customerKind: 'account' },
  });
  if (!order) throw notFound('Order not found.');
  if (order.fulfilmentStatus !== 'delivered') {
    throw conflict('Returns can only be requested after the order has been delivered.');
  }

  // Load line
  const lines = await prisma.$queryRawUnsafe<Array<{
    id: string; variant_id: string; quantity: number; cancelled_qty: number;
    returned_qty: number; delivered_at: Date | null; return_window_days: number | null;
    unit_price: number; line_total: number; name_en: string; product_id: string;
  }>>(
    `SELECT id, variantId AS variant_id, quantity, cancelled_qty, returned_qty, delivered_at, return_window_days,
              unitPrice AS unit_price, lineTotal AS line_total, nameEn AS name_en, productId AS product_id
       FROM order_lines WHERE id = ? AND orderId = ?`,
    input.lineId, input.orderId,
  );
  const line = lines[0];
  if (!line) throw notFound('Order line not found.');

  // Quantity check
  const cancelledQty = line.cancelled_qty ?? 0;
  const returnedQty = line.returned_qty ?? 0;
  const eligibleQty = line.quantity - cancelledQty - returnedQty;
  if (input.qty > eligibleQty) {
    throw badRequest(`Cannot return ${input.qty} — only ${eligibleQty} eligible units remain.`);
  }

  // Check for existing active return on same line covering the requested qty
  const activeReturns = await prisma.$queryRawUnsafe<Array<{ requested_qty: number }>>(
    `SELECT requested_qty FROM return_requests
       WHERE order_line_id = ? AND status NOT IN ('rejected','withdrawn','closed')`,
    input.lineId,
  );
  const pendingQty = activeReturns.reduce((s, r) => s + r.requested_qty, 0);
  if (pendingQty + input.qty > eligibleQty) {
    throw conflict(`Only ${eligibleQty - pendingQty} units are not already covered by a pending return.`);
  }

  // Return window: use line-level override if set, else product returnDays, else 7-day default
  const windowDays = line.return_window_days ?? 7;

  // Delivered-at check: use line.delivered_at if set; otherwise fall back to order.updatedAt as proxy
  const deliveredAt = line.delivered_at ?? order.updatedAt;
  const deadlineMs = new Date(deliveredAt).getTime() + windowDays * 24 * 60 * 60 * 1000;
  if (Date.now() > deadlineMs) {
    throw conflict(`The ${windowDays}-day return window for this item has closed.`);
  }

  // Check product returnsAllowed
  const product = await prisma.$queryRawUnsafe<Array<{ returns_allowed: number }>>(
    `SELECT COALESCE(returnsAllowed, 1) AS returns_allowed FROM products WHERE id = ?`,
    line.product_id,
  );
  if (product[0] && product[0].returns_allowed === 0) {
    throw conflict('This product is not eligible for returns.');
  }

  // Refund the requested units' share of what was actually paid, including tax/shipping and any
  // order-level discount. For a single-line full return this is exactly order.total.
  const refundableAmount = calculateRefundableAmount({
    orderTotal: order.total,
    orderSubtotal: order.subtotal,
    lineTotal: line.line_total,
    lineQuantity: line.quantity,
    requestedQuantity: input.qty,
  });

  const id = randomHexId(12);
  const reference = generateReturnRef();
  const photosJson = JSON.stringify(input.photos ?? []);

  // Validate refund account ownership if provided
  if (input.refundAccountId) {
    const acctRows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM customer_bank_accounts WHERE id = ? AND customer_id = ? AND is_active = 1`,
      input.refundAccountId, customerId,
    );
    if (!acctRows[0]) {
      throw badRequest('Refund bank account not found or does not belong to you.');
    }
  }

  await prisma.$executeRawUnsafe(
    `INSERT INTO return_requests
       (id, reference, order_id, order_line_id, variant_id, requested_qty, reason, customer_note,
        photos, status, shipping_method, refundable_amount, return_window_days, refund_account_id, requested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?, ?, NOW(3))`,
    id, reference, input.orderId, input.lineId, line.variant_id,
    input.qty, input.reason, input.note ?? null, photosJson,
    input.shippingMethod ?? null, refundableAmount, windowDays, input.refundAccountId ?? null,
  );

  // Reserve qty
  await prisma.$executeRawUnsafe(
    `UPDATE order_lines SET returned_qty = returned_qty + ? WHERE id = ?`,
    input.qty, input.lineId,
  );

  // Log event
  const evId = randomHexId(12);
  await prisma.$executeRawUnsafe(
    `INSERT INTO return_events (id, return_id, type, actor, actor_id, message, created_at)
       VALUES (?, ?, 'requested', 'customer', ?, ?, NOW(3))`,
    evId, id, customerId, `Return requested: ${input.qty} unit(s). Reason: ${input.reason}`,
  );

  // Add order event
  await prisma.orderEvent.create({
    data: {
      orderId: input.orderId,
      type: 'return',
      message: `Return request ${reference} submitted for ${input.qty} unit(s) of ${line.name_en}.`,
      actor: 'customer',
    },
  });

  return fetchReturnWithDetails(id);
}

export async function listCustomerReturns(customerId: string) {
  return prisma.$queryRawUnsafe<ReturnRequestRow[]>(
    `SELECT rr.* FROM return_requests rr
       JOIN orders o ON o.id = rr.order_id
       WHERE o.customerId = ? AND o.customerKind = 'account'
       ORDER BY rr.requested_at DESC`,
    customerId,
  );
}

export async function getCustomerReturn(customerId: string, reference: string) {
  const row = await loadReturnForCustomer(reference, customerId);
  const { events, refund } = await fetchReturnWithDetails(row.id);
  return { row, events, refund };
}

/** Withdraws a still-unreviewed request and releases the reserved quantity. Returns the reference. */
export async function withdrawReturn(customerId: string, reference: string) {
  const row = await loadReturnForCustomer(reference, customerId);
  if (row.status !== 'requested') {
    throw conflict('This return request can no longer be withdrawn — it has already been reviewed.');
  }

  await prisma.$executeRawUnsafe(
    `UPDATE return_requests SET status = 'withdrawn', decided_at = NOW(3) WHERE id = ?`,
    row.id,
  );
  // Release reserved quantity
  await prisma.$executeRawUnsafe(
    `UPDATE order_lines SET returned_qty = GREATEST(0, returned_qty - ?) WHERE id = ?`,
    row.requested_qty, row.order_line_id,
  );

  const evId = randomHexId(12);
  await prisma.$executeRawUnsafe(
    `INSERT INTO return_events (id, return_id, type, actor, actor_id, message, created_at)
       VALUES (?, ?, 'withdrawn', 'customer', ?, 'Customer withdrew the return request.', NOW(3))`,
    evId, row.id, customerId,
  );

  return row.reference;
}
