import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { requireCustomer } from '../customerAuth.js';
import { prisma } from '../db.js';
import { badRequest, conflict, notFound, route } from '../http.js';
import { toPublicReturn, type ReturnRequestRow, type ReturnEventRow, type RefundRow } from '../mappers.js';
import { cancelLineSchema, createReturnSchema } from '../validation.js';

// Customer-facing cancellation and return requests.
// All endpoints require an authenticated customer session.
// Raw SQL used throughout because the Prisma client cannot be regenerated while server holds the DLL.

function newId() { return randomBytes(12).toString('hex'); }
function generateReturnRef() { return 'RET-' + randomBytes(4).toString('hex').toUpperCase(); }

async function fetchReturnRows(returnId: string) {
  const [rows, events, refunds] = await Promise.all([
    prisma.$queryRawUnsafe<ReturnRequestRow[]>(`SELECT * FROM return_requests WHERE id = ?`, returnId),
    prisma.$queryRawUnsafe<ReturnEventRow[]>(`SELECT * FROM return_events WHERE return_id = ? ORDER BY created_at ASC`, returnId),
    prisma.$queryRawUnsafe<RefundRow[]>(`SELECT * FROM refunds WHERE return_id = ?`, returnId),
  ]);
  return { row: rows[0] ?? null, events, refund: refunds[0] ?? null };
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

// ---- Item cancellation (separate mini-router, mounted at /api/customer/orders) ----

export const customerCancelRouter = Router();
customerCancelRouter.use(requireCustomer);

customerCancelRouter.post(
  '/:orderId/lines/:lineId/cancel',
  route(async (req, res) => {
    const input = cancelLineSchema.parse(req.body);
    const customerId = req.customer!.sub;
    const { orderId, lineId } = req.params;

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

    res.json({ ok: true, cancelledQty, allCancelled, orderCancelled });
  }),
);

// ---- Return requests (mounted at /api/customer/returns) ----

export const customerReturnsRouter = Router();
customerReturnsRouter.use(requireCustomer);

customerReturnsRouter.post(
  '/',
  route(async (req, res) => {
    const input = createReturnSchema.parse(req.body);
    const customerId = req.customer!.sub;

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

    // Calculate refundable amount: proportional unit price * qty
    const refundableAmount = Math.round((line.unit_price * input.qty));

    const id = newId();
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
    const evId = newId();
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

    const { row, events, refund } = await fetchReturnRows(id);
    res.status(201).json(toPublicReturn(row!, events, refund));
  }),
);

customerReturnsRouter.get(
  '/',
  route(async (req, res) => {
    const customerId = req.customer!.sub;
    const rows = await prisma.$queryRawUnsafe<ReturnRequestRow[]>(
      `SELECT rr.* FROM return_requests rr
       JOIN orders o ON o.id = rr.order_id
       WHERE o.customerId = ? AND o.customerKind = 'account'
       ORDER BY rr.requested_at DESC`,
      customerId,
    );
    res.json({ items: rows.map(r => toPublicReturn(r)) });
  }),
);

customerReturnsRouter.get(
  '/:ref',
  route(async (req, res) => {
    const customerId = req.customer!.sub;
    const row = await loadReturnForCustomer(req.params.ref, customerId);
    const { events, refund } = await fetchReturnRows(row.id).then(r => ({ events: r.events, refund: r.refund }));
    res.json(toPublicReturn(row, events, refund));
  }),
);

customerReturnsRouter.delete(
  '/:ref',
  route(async (req, res) => {
    const customerId = req.customer!.sub;
    const row = await loadReturnForCustomer(req.params.ref, customerId);
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

    const evId = newId();
    await prisma.$executeRawUnsafe(
      `INSERT INTO return_events (id, return_id, type, actor, actor_id, message, created_at)
       VALUES (?, ?, 'withdrawn', 'customer', ?, 'Customer withdrew the return request.', NOW(3))`,
      evId, row.id, customerId,
    );

    res.json({ ok: true, reference: row.reference });
  }),
);
