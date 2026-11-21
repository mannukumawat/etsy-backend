import { prisma } from '../../shared/database/prisma.js';
import { badRequest, conflict, notFound } from '../../shared/errors/http-error.js';
import { randomHexId } from '../../shared/utils/ids.js';
import { adjustmentData } from '../../shared/utils/inventory-adjustments.js';
import { fetchReturnWithDetails, toReturnRequestRow, type ReturnRequestModel } from './return.repository.js';
import { applyOrderRefundTotals, issueOrderRefund, type OrderLike } from '../orders/refund.service.js';
import { emitNotificationEvent } from '../../shared/events/notification-events.js';
import type {
  AddReturnNoteInput, ApproveReturnInput, ArrangePickupInput, InspectReturnInput, ProcessReturnRefundInput,
  ReceiveReturnInput, RecordReturnShippingInput, RejectReturnInput,
} from './return.schema.js';
import type { OwnerActor, ReturnLineSummary, ReturnListRow, ReturnRequestRow } from './return.types.js';

// Owner-side return workflow:
//   requested -> approved -> (shipping_arranged | in_transit) -> received -> inspected -> refunded
// (or rejected / withdrawn). Backed by the Prisma ReturnRequest / ReturnEvent /
// Refund models. All money movement goes through refund.service's issueOrderRefund —
// this file writes no refund rows itself.

async function loadReturnOr404(id: string) {
  const row = await prisma.returnRequest.findUnique({ where: { id } });
  if (!row) throw notFound('Return request not found.');
  return toReturnRequestRow(row);
}

function assertStatus(row: ReturnRequestRow, ...allowed: string[]) {
  if (!allowed.includes(row.status)) {
    throw conflict(`Cannot perform this action when status is '${row.status}'.`);
  }
}

async function addEvent(returnId: string, type: string, actor: 'admin' | 'system', message: string, actorId?: string) {
  await prisma.returnEvent.create({
    data: {
      id: randomHexId(12),
      returnId,
      type,
      actor,
      actorId: actorId ?? null,
      message,
    },
  });
}

/** Appends a note to the admin_note column the way CONCAT_WS did (skips empty parts). */
function appendAdminNote(existing: string | null, note: string | null | undefined): string | null {
  const parts = [existing, note].filter((p): p is string => !!p);
  return parts.length ? parts.join(' | ') : existing;
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

  // The search text matches order number / customer email / customer name, so the
  // matching order ids are resolved first (one query), then the returns are
  // filtered by them — no N+1, and no loading all returns to filter in JS.
  // An orderId filter and a search term combine (AND), exactly as before.
  let orderIds: string[] | undefined;
  if (q) {
    const matching = await prisma.order.findMany({
      where: {
        OR: [
          { number: { contains: q } },
          { customerEmail: { contains: q } },
          { customerName: { contains: q } },
        ],
      },
      select: { id: true },
    });
    orderIds = matching.map((o: { id: string }) => o.id);
    if (orderId && orderIds) orderIds = orderIds.filter((id) => id === orderId);
  } else if (orderId) {
    orderIds = [orderId];
  }

  const where: { status?: string; orderId?: { in: string[] } } = {};
  if (status) where.status = status;
  if (orderIds) where.orderId = { in: orderIds };

  const [total, rows, counts] = await Promise.all([
    prisma.returnRequest.count({ where }),
    orderIds && orderIds.length === 0
      ? Promise.resolve([])
      : prisma.returnRequest.findMany({
          where,
          orderBy: { requestedAt: 'desc' },
          take: pageSize,
          skip: offset,
        }),
    prisma.returnRequest.groupBy({ by: ['status'], _count: { _all: true } }),
  ]);
  const statusCounts = Object.fromEntries(counts.map((c: { status: string; _count: { _all: number } }) => [c.status, c._count._all]));

  // Enrich the page with the order / line columns the admin table shows, in two
  // batched queries (no N+1).
  type ListOrder = { id: string; number: string; customerEmail: string; customerName: string };
  type ListLine = { id: string; nameEn: string; variantLabelEn: string; unitPrice: number };
  const orderIdList = [...new Set(rows.map((r: ReturnRequestModel) => r.orderId))];
  const lineIdList = [...new Set(rows.map((r: ReturnRequestModel) => r.orderLineId))];
  const [orders, lines]: [ListOrder[], ListLine[]] = await Promise.all([
    orderIdList.length
      ? prisma.order.findMany({
          where: { id: { in: orderIdList } },
          select: { id: true, number: true, customerEmail: true, customerName: true },
        })
      : Promise.resolve([] as ListOrder[]),
    lineIdList.length
      ? prisma.orderLine.findMany({
          where: { id: { in: lineIdList } },
          select: { id: true, nameEn: true, variantLabelEn: true, unitPrice: true },
        })
      : Promise.resolve([] as ListLine[]),
  ]);
  const orderById = new Map(orders.map((o: ListOrder) => [o.id, o] as const));
  const lineById = new Map(lines.map((l: ListLine) => [l.id, l] as const));
  const enriched: ReturnListRow[] = rows.map((r: ReturnRequestModel) => {
    const row = toReturnRequestRow(r);
    const o = orderById.get(r.orderId);
    const l = lineById.get(r.orderLineId);
    return {
      ...row,
      order_number: o?.number ?? '',
      customer_email: o?.customerEmail ?? '',
      customer_name: o?.customerName ?? '',
      name_en: l?.nameEn ?? '',
      variant_label_en: l?.variantLabelEn ?? '',
      unit_price: l?.unitPrice ?? 0,
    };
  });

  return { rows: enriched, total, pageCount: Math.max(1, Math.ceil(total / pageSize)), statusCounts };
}

export async function getReturnDetail(id: string) {
  const { row, events, refund } = await fetchReturnWithDetails(id);
  if (!row) throw notFound('Return request not found.');

  // Enrich with order + line info
  const order = await prisma.order.findUnique({ where: { id: row.order_id } });
  const line = await prisma.orderLine.findUnique({
    where: { id: row.order_line_id },
    select: { nameEn: true, variantLabelEn: true, unitPrice: true },
  });
  const lineSummary: ReturnLineSummary | undefined = line
    ? { name_en: line.nameEn, variant_label_en: line.variantLabelEn, unit_price: line.unitPrice }
    : undefined;

  return { row, events, refund, order, line: lineSummary };
}

export async function approveReturn(id: string, input: ApproveReturnInput, actor: OwnerActor) {
  const row = await loadReturnOr404(id);
  assertStatus(row, 'requested');
  if (input.approvedQty > row.requested_qty) {
    throw badRequest(`Cannot approve more than the requested ${row.requested_qty} units.`);
  }

  await prisma.returnRequest.update({
    where: { id: row.id },
    data: {
      status: 'approved',
      approvedQty: input.approvedQty,
      shippingFee: input.shippingFee ?? 0,
      adminNote: input.note ?? null,
      decidedAt: new Date(),
    },
  });
  await addEvent(row.id, 'approved', 'admin', `Approved ${input.approvedQty} unit(s).${input.note ? ' Note: ' + input.note : ''}`, actor.id);

  return fetchReturnWithDetails(row.id);
}

export async function rejectReturn(id: string, input: RejectReturnInput, actor: OwnerActor) {
  const row = await loadReturnOr404(id);
  assertStatus(row, 'requested');

  await prisma.$transaction(async (tx: any) => {
    await tx.returnRequest.update({
      where: { id: row.id },
      data: { status: 'rejected', rejectionReason: input.reason, decidedAt: new Date() },
    });
    // Release reserved quantity
    const line = await tx.orderLine.findUnique({
      where: { id: row.order_line_id },
      select: { returnedQty: true },
    });
    if (line) {
      await tx.orderLine.update({
        where: { id: row.order_line_id },
        data: { returnedQty: Math.max(0, line.returnedQty - row.requested_qty) },
      });
    }
    await tx.returnEvent.create({
      data: {
        id: randomHexId(12),
        returnId: row.id,
        type: 'rejected',
        actor: 'admin',
        actorId: actor.id,
        message: `Rejected: ${input.reason}`,
      },
    });
  });

  return fetchReturnWithDetails(row.id);
}

export async function arrangeReturnPickup(id: string, input: ArrangePickupInput, actor: OwnerActor) {
  const row = await loadReturnOr404(id);
  assertStatus(row, 'approved');

  await prisma.returnRequest.update({
    where: { id: row.id },
    data: {
      status: 'shipping_arranged',
      shippingMethod: 'pickup',
      pickupAddress: input.pickupAddress,
      returnCarrier: input.carrier ?? null,
    },
  });
  await addEvent(row.id, 'pickup_arranged', 'admin', `Pickup arranged.${input.note ? ' ' + input.note : ''}`, actor.id);

  return fetchReturnWithDetails(row.id);
}

/** Customer self-ships the return: records their carrier + tracking. */
export async function recordReturnShipping(id: string, input: RecordReturnShippingInput, actor: OwnerActor) {
  const row = await loadReturnOr404(id);
  assertStatus(row, 'approved');

  await prisma.returnRequest.update({
    where: { id: row.id },
    data: {
      status: 'in_transit',
      shippingMethod: 'self_ship',
      customerCarrier: input.carrier,
      customerTracking: input.tracking,
    },
  });
  await addEvent(row.id, 'in_transit', 'admin', `Return in transit: ${input.carrier} ${input.tracking}`, actor.id);

  return fetchReturnWithDetails(row.id);
}

export async function receiveReturn(id: string, input: ReceiveReturnInput, actor: OwnerActor) {
  const row = await loadReturnOr404(id);
  assertStatus(row, 'shipping_arranged', 'in_transit');
  if (input.receivedQty > (row.approved_qty ?? row.requested_qty)) {
    throw badRequest('Received quantity cannot exceed approved quantity.');
  }

  await prisma.returnRequest.update({
    where: { id: row.id },
    data: { status: 'received', receivedQty: input.receivedQty, receivedAt: new Date() },
  });
  await addEvent(row.id, 'received', 'admin', `Received ${input.receivedQty} unit(s).${input.note ? ' ' + input.note : ''}`, actor.id);

  return fetchReturnWithDetails(row.id);
}

/** Records the inspection outcome and (optionally) puts the accepted units back into stock.
 *  The restock, the history row, the status update and the timeline event all run in
 *  ONE transaction — a mid-way failure used to leave stock restored but the return
 *  un-inspected (or vice versa). The restock is an atomic increment, not
 *  read-then-write. A missing variant is recorded in the event text instead of
 *  completing silently with units never returned. */
export async function inspectReturn(id: string, input: InspectReturnInput, actor: OwnerActor) {
  const row = await loadReturnOr404(id);
  assertStatus(row, 'received');
  const received = row.received_qty ?? 0;
  if (input.acceptedQty + input.rejectedQty > received) {
    throw badRequest(`Accepted (${input.acceptedQty}) + rejected (${input.rejectedQty}) cannot exceed received (${received}).`);
  }

  await prisma.$transaction(async (tx: any) => {
    let restockQty = 0;
    let restockSkipped = false;
    if (input.restockAccepted && input.acceptedQty > 0) {
      // Restore stock for accepted qty
      const line = await tx.orderLine.findUnique({
        where: { id: row.order_line_id },
        select: { variantId: true, sku: true, nameEn: true, nameHi: true, variantLabelEn: true, productId: true },
      });
      if (line) {
        const variant = await tx.productVariant.findUnique({
          where: { id: line.variantId },
          select: { stock: true, product: { select: { id: true, nameEn: true, nameHi: true } } },
        });
        if (variant) {
          const updated = await tx.productVariant.updateMany({ where: { id: line.variantId }, data: { stock: { increment: input.acceptedQty } } });
          if (updated.count === 0) {
            restockSkipped = true;
          } else {
            const afterRow = await tx.productVariant.findUnique({ where: { id: line.variantId }, select: { stock: true } });
            const after = afterRow?.stock ?? variant.stock + input.acceptedQty;
            const before = after - input.acceptedQty;
            await tx.inventoryAdjustment.create({
              data: adjustmentData({
                productId: variant.product.id,
                variantId: line.variantId,
                sku: line.sku,
                productNameEn: variant.product.nameEn,
                productNameHi: variant.product.nameHi,
                variantLabel: line.variantLabelEn,
                before,
                after,
                reason: 'return_received',
                note: `Restocked from return ${row.reference}: ${input.acceptedQty} accepted.`,
                actor: actor.email,
              }),
            });
            restockQty = input.acceptedQty;
          }
        } else {
          restockSkipped = true;
        }
      } else {
        restockSkipped = true;
      }
    }

    // Guarded by status so a concurrent inspection cannot overwrite this one.
    const updated = await tx.returnRequest.updateMany({
      where: { id: row.id, status: 'received' },
      data: {
        status: 'inspected',
        acceptedQty: input.acceptedQty,
        restockQty,
        inspectedAt: new Date(),
        adminNote: appendAdminNote(row.admin_note, input.note),
      },
    });
    if (updated.count === 0) {
      throw conflict('This return is no longer awaiting inspection. Refresh and try again.');
    }
    await tx.returnEvent.create({
      data: {
        id: randomHexId(12),
        returnId: row.id,
        type: 'inspected',
        actor: 'admin',
        actorId: actor.id,
        message: `Inspected: ${input.acceptedQty} accepted, ${input.rejectedQty} rejected.${restockQty ? ' Restocked ' + restockQty + ' units.' : ''}${restockSkipped ? ' Note: the variant no longer exists, so accepted units could not be restocked.' : ''}${input.note ? ' ' + input.note : ''}`,
      },
    });
  });

  return fetchReturnWithDetails(row.id);
}

/**
 * Records the refund for an inspected return. All money movement goes through
 * refund.service's issueOrderRefund (Razorpay for 'original', wallet credit for
 * 'store_credit', a pending row for manual bank/UPI); the refund row it creates is
 * then linked to this return through the Prisma Refund model, and only then does
 * the return move to 'refunded'.
 *
 * One refund per return: Refund.returnId is unique, so a second active refund for
 * the same return is rejected with a clean 409. A previous refund that failed at
 * the gateway is unlinked (kept for audit under its order) so a retry can proceed.
 */
export async function processReturnRefund(id: string, input: ProcessReturnRefundInput, actor: OwnerActor) {
  const row = await loadReturnOr404(id);
  assertStatus(row, 'inspected');

  // Check for an existing refund for this return.
  const existingRefund = await prisma.refund.findFirst({ where: { returnId: row.id } });
  if (existingRefund && existingRefund.status !== 'failed') {
    throw conflict('A refund has already been recorded for this return.');
  }
  if (existingRefund) {
    // Failed at the gateway: free the unique return link so a retry can be recorded.
    await prisma.refund.update({ where: { id: existingRefund.id }, data: { returnId: null } });
  }
  const alreadyRefunded = 0;
  const order = await prisma.order.findUnique({ where: { id: row.order_id } });
  if (!order) throw notFound('Order not found.');
  const returnRemaining = row.refundable_amount - row.shipping_fee - alreadyRefunded;
  const orderRemaining = Math.max(0, order.total - order.refundedTotal);
  const maxRefund = Math.min(returnRemaining, orderRemaining);
  if (input.amount > maxRefund) {
    throw badRequest(`Cannot refund more than the remaining eligible amount (${maxRefund}).`);
  }

  const orderLike: OrderLike = {
    id: order.id,
    number: order.number,
    total: order.total,
    refundedTotal: order.refundedTotal,
    paymentStatus: order.paymentStatus,
    paymentMethod: order.paymentMethod,
    paymentReference: order.paymentReference ?? '',
    currency: order.currency,
    customerId: order.customerId,
  };

  if (input.method === 'store_credit') {
    if (!order.customerId) throw badRequest('Cannot issue a wallet refund for a guest order.');
    const view = await issueOrderRefund(
      orderLike,
      { amount: input.amount, reason: `Return ${row.reference}`, method: 'store_credit', note: input.note },
      actor.email,
    );
    // Link the refund row issueOrderRefund created to this return, then mark the return refunded.
    await prisma.refund.update({ where: { id: view.id }, data: { returnId: row.id } });
    await prisma.returnRequest.update({
      where: { id: row.id },
      data: { status: 'refunded', refundAmount: input.amount, refundedAt: new Date() },
    });
    await addEvent(row.id, 'refunded', 'admin', `Refund of ${input.amount} credited to customer wallet.`, actor.id);

    // Notify the customer: the wallet transaction id and new balance live on the
    // wallet ledger rows issueOrderRefund wrote.
    const walletTx = view.reference
      ? await prisma.walletTransaction.findUnique({ where: { reference: view.reference }, select: { id: true } })
      : null;
    const balance = await prisma.walletBalance.findUnique({
      where: { customerId: order.customerId },
      select: { balanceMinor: true },
    });
    if (walletTx && balance) {
      void emitNotificationEvent({
        type: 'wallet.refunded',
        customerId: order.customerId,
        amountMinor: input.amount,
        walletTxId: walletTx.id,
        returnId: row.id,
        newBalanceMinor: balance.balanceMinor,
      });
    }

    return fetchReturnWithDetails(row.id);
  }

  if (input.method === 'original') {
    const view = await issueOrderRefund(
      orderLike,
      { amount: input.amount, reason: `Return ${row.reference}`, method: 'original' },
      actor.email,
    );
    await prisma.refund.update({ where: { id: view.id }, data: { returnId: row.id } });
    if (view.status === 'completed') {
      await prisma.returnRequest.update({
        where: { id: row.id },
        data: { status: 'refunded', refundAmount: input.amount, refundedAt: new Date() },
      });
      await addEvent(row.id, 'refunded', 'admin', `Refund of ${input.amount} via Razorpay (refund ${view.reference ?? view.id}).`, actor.id);
    } else {
      // Gateway accepted the refund but has not settled it yet: the return stays
      // 'inspected' and the order totals stay put until it completes.
      await addEvent(
        row.id,
        'refunded',
        'admin',
        `Razorpay refund ${view.reference ?? view.id} is processing (${input.amount} ${order.currency}). The return will be marked refunded once it settles.`,
        actor.id,
      );
    }
    return fetchReturnWithDetails(row.id);
  }

  // Manual bank/UPI: issueOrderRefund records a 'pending' refund (a reference is
  // mandatory) and moves nothing until an admin verifies it (verifyReturnRefund).
  const view = await issueOrderRefund(
    orderLike,
    { amount: input.amount, reason: `Return ${row.reference}`, method: input.method, reference: input.reference?.trim(), note: input.note },
    actor.email,
  );
  await prisma.refund.update({ where: { id: view.id }, data: { returnId: row.id } });
  await addEvent(row.id, 'note', 'admin', `Manual refund of ${input.amount} recorded (pending verification, ref ${view.reference ?? input.reference?.trim() ?? '—'}).`, actor.id);

  return fetchReturnWithDetails(row.id);
}

/**
 * Verifies a pending manual (bank/UPI) return refund: marks it completed and only then
 * moves the order totals and the return to 'refunded'. The completion/verification step
 * manual refunds were missing.
 */
export async function verifyReturnRefund(id: string, actor: OwnerActor) {
  const row = await loadReturnOr404(id);
  const { refund } = await fetchReturnWithDetails(id);
  if (!refund) throw notFound('No refund recorded for this return.');
  if (!['manual_bank', 'manual_upi'].includes(refund.method)) {
    throw badRequest('Only manual bank/UPI refunds need verification.');
  }
  if (refund.status !== 'pending') {
    throw conflict(`This refund is already '${refund.status}'.`);
  }
  const order = await prisma.order.findUnique({ where: { id: row.order_id } });
  if (!order) throw notFound('Order not found.');
  await prisma.$transaction(async (tx: any) => {
    await tx.refund.update({
      where: { id: refund.id },
      data: { status: 'completed', completedAt: new Date() },
    });
    await applyOrderRefundTotals(
      tx,
      order,
      refund.amount,
      `Manual refund of ${refund.amount} ${order.currency} verified for return ${row.reference} (ref ${refund.reference ?? '—'}).`,
    );
    await tx.returnRequest.update({
      where: { id: row.id },
      data: { status: 'refunded', refundAmount: refund.amount, refundedAt: new Date() },
    });
  });
  await addEvent(row.id, 'refunded', 'admin', `Manual refund of ${refund.amount} verified (ref ${refund.reference ?? '—'}).`, actor.id);
  return fetchReturnWithDetails(row.id);
}

export async function addReturnNote(id: string, input: AddReturnNoteInput, actor: OwnerActor) {
  const row = await loadReturnOr404(id);

  await addEvent(row.id, 'note', 'admin', input.body, actor.id);
  // Append to admin_note for quick visibility
  await prisma.returnRequest.update({
    where: { id: row.id },
    data: { adminNote: appendAdminNote(row.admin_note, input.body) },
  });

  return fetchReturnWithDetails(row.id);
}
