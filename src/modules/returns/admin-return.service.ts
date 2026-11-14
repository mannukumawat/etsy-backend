import { prisma } from '../../shared/database/prisma.js';
import { badRequest, conflict, notFound } from '../../shared/errors/http-error.js';
import { randomHexId } from '../../shared/utils/ids.js';
import { fetchReturnWithDetails } from './return.repository.js';
import type {
  AddReturnNoteInput, ApproveReturnInput, ArrangePickupInput, InspectReturnInput, ProcessReturnRefundInput,
  ReceiveReturnInput, RecordReturnShippingInput, RejectReturnInput,
} from './return.schema.js';
import type { OwnerActor, ReturnLineSummary, ReturnListRow, ReturnRequestRow } from './return.types.js';

// Owner-side return workflow:
//   requested -> approved -> (shipping_arranged | in_transit) -> received -> inspected -> refunded
// (or rejected / withdrawn). Raw SQL throughout: the return tables live outside the Prisma model
// (created by migrate-returns.ts).

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
  const id = randomHexId(12);
  await prisma.$executeRawUnsafe(
    `INSERT INTO return_events (id, return_id, type, actor, actor_id, message, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NOW(3))`,
    id, returnId, type, actor, actorId ?? null, message,
  );
}

export interface ReturnListQuery {
  status: string;
  orderId: string;
  q: string;
  page: number;
}

/** List with filters + pagination (20 per page), plus per-status counts across all returns. */
export async function listReturns({ status, orderId, q, page }: ReturnListQuery) {
  const pageSize = 20;
  const offset = (page - 1) * pageSize;

  let where = '1=1';
  const params: unknown[] = [];
  if (status) { where += ' AND rr.status = ?'; params.push(status); }
  if (orderId) { where += ' AND rr.order_id = ?'; params.push(orderId); }
  if (q) {
    where += ' AND (rr.reference LIKE ? OR o.customerEmail LIKE ? OR o.customerName LIKE ? OR o.number LIKE ?)';
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }

  const countRows = await prisma.$queryRawUnsafe<Array<{ total: number }>>(
    `SELECT COUNT(*) as total FROM return_requests rr JOIN orders o ON o.id = rr.order_id WHERE ${where}`,
    ...params,
  );
  const total = Number(countRows[0]?.total ?? 0);

  const rows = await prisma.$queryRawUnsafe<ReturnListRow[]>(
    `SELECT rr.*, o.number as order_number, o.customerEmail AS customer_email, o.customerName AS customer_name,
              ol.nameEn AS name_en, ol.variantLabelEn AS variant_label_en, ol.unitPrice AS unit_price
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

  return { rows, total, pageCount: Math.max(1, Math.ceil(total / pageSize)), statusCounts };
}

export async function getReturnDetail(id: string) {
  const { row, events, refund } = await fetchReturnWithDetails(id);
  if (!row) throw notFound('Return request not found.');

  // Enrich with order + line info
  const order = await prisma.order.findUnique({ where: { id: row.order_id } });
  const lines = await prisma.$queryRawUnsafe<ReturnLineSummary[]>(
    `SELECT nameEn AS name_en, variantLabelEn AS variant_label_en, unitPrice AS unit_price FROM order_lines WHERE id = ?`, row.order_line_id,
  );

  return { row, events, refund, order, line: lines[0] };
}

export async function approveReturn(id: string, input: ApproveReturnInput, actor: OwnerActor) {
  const row = await loadReturnOr404(id);
  assertStatus(row, 'requested');
  if (input.approvedQty > row.requested_qty) {
    throw badRequest(`Cannot approve more than the requested ${row.requested_qty} units.`);
  }

  await prisma.$executeRawUnsafe(
    `UPDATE return_requests SET status = 'approved', approved_qty = ?, shipping_fee = ?, admin_note = ?, decided_at = NOW(3) WHERE id = ?`,
    input.approvedQty, input.shippingFee ?? 0, input.note ?? null, row.id,
  );
  await addEvent(row.id, 'approved', 'admin', `Approved ${input.approvedQty} unit(s).${input.note ? ' Note: ' + input.note : ''}`, actor.id);

  return fetchReturnWithDetails(row.id);
}

export async function rejectReturn(id: string, input: RejectReturnInput, actor: OwnerActor) {
  const row = await loadReturnOr404(id);
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
  await addEvent(row.id, 'rejected', 'admin', `Rejected: ${input.reason}`, actor.id);

  return fetchReturnWithDetails(row.id);
}

export async function arrangeReturnPickup(id: string, input: ArrangePickupInput, actor: OwnerActor) {
  const row = await loadReturnOr404(id);
  assertStatus(row, 'approved');

  await prisma.$executeRawUnsafe(
    `UPDATE return_requests SET status = 'shipping_arranged', shipping_method = 'pickup', pickup_address = ?, return_carrier = ? WHERE id = ?`,
    input.pickupAddress, input.carrier ?? null, row.id,
  );
  await addEvent(row.id, 'pickup_arranged', 'admin', `Pickup arranged.${input.note ? ' ' + input.note : ''}`, actor.id);

  return fetchReturnWithDetails(row.id);
}

/** Customer self-ships the return: records their carrier + tracking. */
export async function recordReturnShipping(id: string, input: RecordReturnShippingInput, actor: OwnerActor) {
  const row = await loadReturnOr404(id);
  assertStatus(row, 'approved');

  await prisma.$executeRawUnsafe(
    `UPDATE return_requests SET status = 'in_transit', shipping_method = 'self_ship', customer_carrier = ?, customer_tracking = ? WHERE id = ?`,
    input.carrier, input.tracking, row.id,
  );
  await addEvent(row.id, 'in_transit', 'admin', `Return in transit: ${input.carrier} ${input.tracking}`, actor.id);

  return fetchReturnWithDetails(row.id);
}

export async function receiveReturn(id: string, input: ReceiveReturnInput, actor: OwnerActor) {
  const row = await loadReturnOr404(id);
  assertStatus(row, 'shipping_arranged', 'in_transit');
  if (input.receivedQty > (row.approved_qty ?? row.requested_qty)) {
    throw badRequest('Received quantity cannot exceed approved quantity.');
  }

  await prisma.$executeRawUnsafe(
    `UPDATE return_requests SET status = 'received', received_qty = ?, received_at = NOW(3) WHERE id = ?`,
    input.receivedQty, row.id,
  );
  await addEvent(row.id, 'received', 'admin', `Received ${input.receivedQty} unit(s).${input.note ? ' ' + input.note : ''}`, actor.id);

  return fetchReturnWithDetails(row.id);
}

/** Records the inspection outcome and (optionally) puts the accepted units back into stock. */
export async function inspectReturn(id: string, input: InspectReturnInput, actor: OwnerActor) {
  const row = await loadReturnOr404(id);
  assertStatus(row, 'received');
  const received = row.received_qty ?? 0;
  if (input.acceptedQty + input.rejectedQty > received) {
    throw badRequest(`Accepted (${input.acceptedQty}) + rejected (${input.rejectedQty}) cannot exceed received (${received}).`);
  }

  let restockQty = 0;
  if (input.restockAccepted && input.acceptedQty > 0) {
    // Restore stock for accepted qty
    const lines = await prisma.$queryRawUnsafe<Array<{ variant_id: string; sku: string; name_en: string; name_hi: string; variant_label_en: string; product_id: string }>>(
      `SELECT ol.variantId AS variant_id, ol.sku, ol.nameEn AS name_en, ol.nameHi AS name_hi, ol.variantLabelEn AS variant_label_en, ol.productId AS product_id FROM order_lines ol WHERE ol.id = ?`,
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
            actor: actor.email,
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
    actor.id,
  );

  return fetchReturnWithDetails(row.id);
}

/** Records the refund for an inspected return and rolls it into the order's refunded total / payment status. */
export async function processReturnRefund(id: string, input: ProcessReturnRefundInput, actor: OwnerActor) {
  const row = await loadReturnOr404(id);
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

  const refundId = randomHexId(12);
  await prisma.$executeRawUnsafe(
    `INSERT INTO refunds (id, order_id, return_id, amount, reason, method, status, reference, completed_at, recorded_by, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3), NOW(3))`,
    refundId, row.order_id, row.id, input.amount,
    `Return ${row.reference}`, input.method, status,
    input.reference ?? null, completedAt ?? null, actor.email, input.note ?? null,
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
  await addEvent(row.id, 'refunded', 'admin', `Refund of ${input.amount} initiated via ${input.method}.${input.reference ? ' Ref: ' + input.reference : ''}`, actor.id);

  return fetchReturnWithDetails(row.id);
}

export async function addReturnNote(id: string, input: AddReturnNoteInput, actor: OwnerActor) {
  const row = await loadReturnOr404(id);

  await addEvent(row.id, 'note', 'admin', input.body, actor.id);
  // Append to admin_note for quick visibility
  await prisma.$executeRawUnsafe(
    `UPDATE return_requests SET admin_note = CONCAT_WS(' | ', admin_note, ?) WHERE id = ?`,
    input.body, row.id,
  );

  return fetchReturnWithDetails(row.id);
}
