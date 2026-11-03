import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { requireOwner } from '../auth.js';
import { prisma } from '../db.js';
import { badRequest, conflict, notFound, route } from '../http.js';
import { toAdminReturn, type ReturnRequestRow, type ReturnEventRow, type RefundRow } from '../mappers.js';
import {
  approveReturnSchema,
  rejectReturnSchema,
  arrangePickupSchema,
  recordReturnShippingSchema,
  receiveReturnSchema,
  inspectReturnSchema,
  processReturnRefundSchema,
  addReturnNoteSchema,
} from '../validation.js';

export const adminReturnsRouter = Router();
adminReturnsRouter.use(requireOwner);

function newId() { return randomBytes(12).toString('hex'); }

async function fetchReturnFull(id: string) {
  const [rows, events, refunds] = await Promise.all([
    prisma.$queryRawUnsafe<ReturnRequestRow[]>(`SELECT * FROM return_requests WHERE id = ?`, id),
    prisma.$queryRawUnsafe<ReturnEventRow[]>(`SELECT * FROM return_events WHERE return_id = ? ORDER BY created_at ASC`, id),
    prisma.$queryRawUnsafe<RefundRow[]>(`SELECT * FROM refunds WHERE return_id = ?`, id),
  ]);
  return { row: rows[0] ?? null, events, refund: refunds[0] ?? null };
}

async function loadReturnOr404(id: string) {
  const rows = await prisma.$queryRawUnsafe<ReturnRequestRow[]>(`SELECT * FROM return_requests WHERE id = ?`, id);
  if (!rows[0]) throw notFound('Return request not found.');
  return rows[0];
}

function assertStatus(row: ReturnRequestRow, ...allowed: string[]) {
  if (!allowed.includes(row.status)) {
    throw conflict(`Cannot perform this action when status is '${row.status}'.`);
  }
}

async function addEvent(returnId: string, type: string, actor: 'admin' | 'system', message: string, actorId?: string) {
  const id = newId();
  await prisma.$executeRawUnsafe(
    `INSERT INTO return_events (id, return_id, type, actor, actor_id, message, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NOW(3))`,
    id, returnId, type, actor, actorId ?? null, message,
  );
}

// GET / â€” list with filters + pagination
adminReturnsRouter.get(
  '/',
  route(async (req, res) => {
    const status = String(req.query.status ?? '').trim();
    const orderId = String(req.query.orderId ?? '').trim();
    const q = String(req.query.q ?? '').trim().toLowerCase();
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10));
    const pageSize = 20;
    const offset = (page - 1) * pageSize;

    let where = '1=1';
    const params: unknown[] = [];
    if (status) { where += ' AND rr.status = ?'; params.push(status); }
    if (orderId) { where += ' AND rr.order_id = ?'; params.push(orderId); }
    if (q) {
      where += ' AND (rr.reference LIKE ? OR o.customer_email LIKE ? OR o.customer_name LIKE ? OR o.number LIKE ?)';
      const like = `%${q}%`;
      params.push(like, like, like, like);
    }

    const countRows = await prisma.$queryRawUnsafe<Array<{ total: number }>>(
      `SELECT COUNT(*) as total FROM return_requests rr JOIN orders o ON o.id = rr.order_id WHERE ${where}`,
      ...params,
    );
    const total = Number(countRows[0]?.total ?? 0);

    const rows = await prisma.$queryRawUnsafe<Array<ReturnRequestRow & {
      order_number: string; customer_email: string; customer_name: string;
      name_en: string; variant_label_en: string; unit_price: number;
    }>>(
      `SELECT rr.*, o.number as order_number, o.customer_email, o.customer_name,
              ol.name_en, ol.variant_label_en, ol.unit_price
       FROM return_requests rr
       JOIN orders o ON o.id = rr.order_id
       LEFT JOIN order_lines ol ON ol.id = rr.order_line_id
       WHERE ${where}
       ORDER BY rr.requested_at DESC
       LIMIT ? OFFSET ?`,
      ...params, pageSize, offset,
    );

    // Status counts
    const counts = await prisma.$queryRawUnsafe<Array<{ status: string; cnt: number }>>(
      `SELECT status, COUNT(*) as cnt FROM return_requests GROUP BY status`,
    );
    const statusCounts = Object.fromEntries(counts.map(c => [c.status, Number(c.cnt)]));

    res.json({
      items: rows.map(r => ({
        ...toAdminReturn(r),
        orderNumber: (r as any).order_number,
        customerEmail: (r as any).customer_email,
        customerName: (r as any).customer_name,
        itemName: (r as any).name_en,
        variantLabel: (r as any).variant_label_en,
        unitPrice: (r as any).unit_price,
      })),
      total,
      page,
      pageCount: Math.max(1, Math.ceil(total / pageSize)),
      statusCounts,
    });
  }),
);

// GET /:id â€” detail
adminReturnsRouter.get(
  '/:id',
  route(async (req, res) => {
    const { row, events, refund } = await fetchReturnFull(req.params.id);
    if (!row) throw notFound('Return request not found.');

    // Enrich with order + line info
    const order = await prisma.order.findUnique({ where: { id: row.order_id } });
    const lines = await prisma.$queryRawUnsafe<Array<{ name_en: string; variant_label_en: string; unit_price: number }>>(
      `SELECT name_en, variant_label_en, unit_price FROM order_lines WHERE id = ?`, row.order_line_id,
    );

    res.json({
      ...toAdminReturn(row, events, refund),
      orderNumber: order?.number,
      customerEmail: order?.customerEmail,
      customerName: order?.customerName,
      currency: order?.currency,
      itemName: lines[0]?.name_en,
      variantLabel: lines[0]?.variant_label_en,
      unitPrice: lines[0]?.unit_price,
    });
  }),
);

// PATCH /:id/approve
adminReturnsRouter.patch(
  '/:id/approve',
  route(async (req, res) => {
    const input = approveReturnSchema.parse(req.body);
    const row = await loadReturnOr404(req.params.id);
    assertStatus(row, 'requested');
    if (input.approvedQty > row.requested_qty) {
      throw badRequest(`Cannot approve more than the requested ${row.requested_qty} units.`);
    }

    await prisma.$executeRawUnsafe(
      `UPDATE return_requests SET status = 'approved', approved_qty = ?, shipping_fee = ?, admin_note = ?, decided_at = NOW(3) WHERE id = ?`,
      input.approvedQty, input.shippingFee ?? 0, input.note ?? null, row.id,
    );
    await addEvent(row.id, 'approved', 'admin', `Approved ${input.approvedQty} unit(s).${input.note ? ' Note: ' + input.note : ''}`, req.owner!.sub);

    const { row: updated, events, refund } = await fetchReturnFull(row.id);
    res.json(toAdminReturn(updated!, events, refund));
  }),
);

// PATCH /:id/reject
adminReturnsRouter.patch(
  '/:id/reject',
  route(async (req, res) => {
    const input = rejectReturnSchema.parse(req.body);
    const row = await loadReturnOr404(req.params.id);
    assertStatus(row, 'requested');

    await prisma.$executeRawUnsafe(
      `UPDATE return_requests SET status = 'rejected', rejection_reason = ?, decided_at = NOW(3) WHERE id = ?`,
      input.reason, row.id,
    );
    // Release reserved quantity
    await prisma.$executeRawUnsafe(
      `UPDATE order_lines SET returned_qty = GREATEST(0, returned_qty - ?) WHERE id = ?`,
      row.requested_qty, row.order_line_id,
    );
    await addEvent(row.id, 'rejected', 'admin', `Rejected: ${input.reason}`, req.owner!.sub);

    const { row: updated, events, refund } = await fetchReturnFull(row.id);
    res.json(toAdminReturn(updated!, events, refund));
  }),
);

// PATCH /:id/arrange-pickup
adminReturnsRouter.patch(
  '/:id/arrange-pickup',
  route(async (req, res) => {
    const input = arrangePickupSchema.parse(req.body);
    const row = await loadReturnOr404(req.params.id);
    assertStatus(row, 'approved');

    await prisma.$executeRawUnsafe(
      `UPDATE return_requests SET status = 'shipping_arranged', shipping_method = 'pickup', pickup_address = ?, return_carrier = ? WHERE id = ?`,
      input.pickupAddress, input.carrier ?? null, row.id,
    );
    await addEvent(row.id, 'pickup_arranged', 'admin', `Pickup arranged.${input.note ? ' ' + input.note : ''}`, req.owner!.sub);

    const { row: updated, events, refund } = await fetchReturnFull(row.id);
    res.json(toAdminReturn(updated!, events, refund));
  }),
);

// PATCH /:id/shipping â€” customer self-ships
adminReturnsRouter.patch(
  '/:id/shipping',
  route(async (req, res) => {
    const input = recordReturnShippingSchema.parse(req.body);
    const row = await loadReturnOr404(req.params.id);
    assertStatus(row, 'approved');

    await prisma.$executeRawUnsafe(
      `UPDATE return_requests SET status = 'in_transit', shipping_method = 'self_ship', customer_carrier = ?, customer_tracking = ? WHERE id = ?`,
      input.carrier, input.tracking, row.id,
    );
    await addEvent(row.id, 'in_transit', 'admin', `Return in transit: ${input.carrier} ${input.tracking}`, req.owner!.sub);

    const { row: updated, events, refund } = await fetchReturnFull(row.id);
    res.json(toAdminReturn(updated!, events, refund));
  }),
);

// PATCH /:id/receive
adminReturnsRouter.patch(
  '/:id/receive',
  route(async (req, res) => {
    const input = receiveReturnSchema.parse(req.body);
    const row = await loadReturnOr404(req.params.id);
    assertStatus(row, 'shipping_arranged', 'in_transit');
    if (input.receivedQty > (row.approved_qty ?? row.requested_qty)) {
      throw badRequest('Received quantity cannot exceed approved quantity.');
    }

    await prisma.$executeRawUnsafe(
      `UPDATE return_requests SET status = 'received', received_qty = ?, received_at = NOW(3) WHERE id = ?`,
      input.receivedQty, row.id,
    );
    await addEvent(row.id, 'received', 'admin', `Received ${input.receivedQty} unit(s).${input.note ? ' ' + input.note : ''}`, req.owner!.sub);

    const { row: updated, events, refund } = await fetchReturnFull(row.id);
    res.json(toAdminReturn(updated!, events, refund));
  }),
);

// PATCH /:id/inspect
adminReturnsRouter.patch(
  '/:id/inspect',
  route(async (req, res) => {
    const input = inspectReturnSchema.parse(req.body);
    const row = await loadReturnOr404(req.params.id);
    assertStatus(row, 'received');
    const received = row.received_qty ?? 0;
    if (input.acceptedQty + input.rejectedQty > received) {
      throw badRequest(`Accepted (${input.acceptedQty}) + rejected (${input.rejectedQty}) cannot exceed received (${received}).`);
    }

    let restockQty = 0;
    if (input.restockAccepted && input.acceptedQty > 0) {
      // Restore stock for accepted qty
      const lines = await prisma.$queryRawUnsafe<Array<{ variant_id: string; sku: string; name_en: string; name_hi: string; variant_label_en: string; product_id: string }>>(
        `SELECT ol.variant_id, ol.sku, ol.name_en, ol.name_hi, ol.variant_label_en, ol.product_id FROM order_lines ol WHERE ol.id = ?`,
        row.order_line_id,
      );
      if (lines[0]) {
        const l = lines[0];
        const variant = await prisma.productVariant.findUnique({
          where: { id: l.variant_id },
          select: { stock: true, product: { select: { id: true, nameEn: true, nameHi: true } } },
        });
        if (variant) {
          const before = variant.stock;
          await prisma.productVariant.update({ where: { id: l.variant_id }, data: { stock: before + input.acceptedQty } });
          await prisma.inventoryAdjustment.create({
            data: {
              productId: variant.product.id,
              variantId: l.variant_id,
              sku: l.sku,
              productNameEn: variant.product.nameEn,
              productNameHi: variant.product.nameHi,
              variantLabel: l.variant_label_en,
              before,
              after: before + input.acceptedQty,
              delta: input.acceptedQty,
              reason: 'return_received',
              note: `Restocked from return ${row.reference}: ${input.acceptedQty} accepted.`,
              actor: req.owner!.email,
            },
          });
          restockQty = input.acceptedQty;
        }
      }
    }

    await prisma.$executeRawUnsafe(
      `UPDATE return_requests SET status = 'inspected', accepted_qty = ?, restock_qty = ?, inspected_at = NOW(3), admin_note = CONCAT_WS(' | ', admin_note, ?) WHERE id = ?`,
      input.acceptedQty, restockQty, input.note ?? null, row.id,
    );
    await addEvent(
      row.id, 'inspected', 'admin',
      `Inspected: ${input.acceptedQty} accepted, ${input.rejectedQty} rejected.${restockQty ? ' Restocked ' + restockQty + ' units.' : ''}${input.note ? ' ' + input.note : ''}`,
      req.owner!.sub,
    );

    const { row: updated, events, refund } = await fetchReturnFull(row.id);
    res.json(toAdminReturn(updated!, events, refund));
  }),
);

// POST /:id/refund
adminReturnsRouter.post(
  '/:id/refund',
  route(async (req, res) => {
    const input = processReturnRefundSchema.parse(req.body);
    const row = await loadReturnOr404(req.params.id);
    assertStatus(row, 'inspected');

    // Check for existing refund
    const existingRefunds = await prisma.$queryRawUnsafe<Array<{ amount: number }>>(
      `SELECT amount FROM refunds WHERE return_id = ?`, row.id,
    );
    const alreadyRefunded = existingRefunds.reduce((s, r) => s + r.amount, 0);
    const maxRefund = row.refundable_amount - row.shipping_fee - alreadyRefunded;
    if (input.amount > maxRefund) {
      throw badRequest(`Cannot refund more than the remaining eligible amount (${maxRefund}).`);
    }

    // Determine completed status for non-manual methods
    const isManual = input.method === 'manual_bank' || input.method === 'manual_upi';
    const status = isManual ? 'pending' : 'completed';
    const completedAt = isManual ? null : new Date().toISOString();

    const refundId = newId();
    await prisma.$executeRawUnsafe(
      `INSERT INTO refunds (id, order_id, return_id, amount, reason, method, status, reference, completed_at, recorded_by, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3), NOW(3))`,
      refundId, row.order_id, row.id, input.amount,
      `Return ${row.reference}`, input.method, status,
      input.reference ?? null, completedAt ?? null, req.owner!.email, input.note ?? null,
    );

    // Update order refundedTotal and paymentStatus
    const order = await prisma.order.findUnique({ where: { id: row.order_id } });
    if (order) {
      const newRefundedTotal = order.refundedTotal + input.amount;
      const newPaymentStatus = newRefundedTotal >= order.total ? 'refunded' : 'partially_refunded';
      await prisma.order.update({
        where: { id: row.order_id },
        data: {
          refundedTotal: newRefundedTotal,
          paymentStatus: newPaymentStatus,
          events: {
            create: [{
              type: 'refund',
              message: `Refund of ${input.amount} ${order.currency} for return ${row.reference}. Method: ${input.method}.${input.reference ? ' Ref: ' + input.reference : ''}`,
              actor: 'admin',
            }],
          },
        },
      });
    }

    // Mark return as refunded
    await prisma.$executeRawUnsafe(
      `UPDATE return_requests SET status = 'refunded', refund_amount = ?, refunded_at = NOW(3) WHERE id = ?`,
      input.amount, row.id,
    );
    await addEvent(row.id, 'refunded', 'admin', `Refund of ${input.amount} initiated via ${input.method}.${input.reference ? ' Ref: ' + input.reference : ''}`, req.owner!.sub);

    const { row: updated, events, refund } = await fetchReturnFull(row.id);
    res.json(toAdminReturn(updated!, events, refund));
  }),
);

// POST /:id/notes
adminReturnsRouter.post(
  '/:id/notes',
  route(async (req, res) => {
    const input = addReturnNoteSchema.parse(req.body);
    const row = await loadReturnOr404(req.params.id);

    await addEvent(row.id, 'note', 'admin', input.body, req.owner!.sub);
    // Append to admin_note for quick visibility
    await prisma.$executeRawUnsafe(
      `UPDATE return_requests SET admin_note = CONCAT_WS(' | ', admin_note, ?) WHERE id = ?`,
      input.body, row.id,
    );

    const { row: updated, events, refund } = await fetchReturnFull(row.id);
    res.json(toAdminReturn(updated!, events, refund));
  }),
);

