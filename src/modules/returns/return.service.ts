import { prisma } from '../../shared/database/prisma.js';
import { badRequest, conflict, notFound } from '../../shared/errors/http-error.js';
import { randomHexId } from '../../shared/utils/ids.js';
import { fetchReturnWithDetails, toReturnRequestRow } from './return.repository.js';
import type { CreateReturnInput } from './return.schema.js';

// Customer-side return requests, backed by the Prisma ReturnRequest / ReturnEvent
// models (see prisma/schema.prisma). The create / withdraw sequences run inside a
// transaction, so a mid-sequence failure can never leave a reserved quantity
// without a request, or vice versa (H15).

function generateReturnRef() { return 'RET-' + randomHexId(4).toUpperCase(); }

/** Last-resort window when neither the order line nor the product states one. */
export const DEFAULT_RETURN_WINDOW_DAYS = 7;

export interface DeliveryWindowInput {
  /** When the line itself was delivered (written when the order advances to delivered). */
  deliveredAt: Date | null;
  /** Fallback: the order's `delivered` event timestamp. */
  deliveredEventAt: Date | null;
  /** Per-line window override in days. */
  lineWindowDays: number | null;
  /** Product-level default window in days. */
  productReturnDays: number | null;
}

/**
 * Resolves the return / exchange window. Precedence for the length: the line's
 * override, then the product's returnDays, then the documented 7-day last resort.
 * The window always starts at the delivery timestamp — never at order.updatedAt,
 * which moves on any order write (M4).
 */
export function resolveDeliveryWindow(input: DeliveryWindowInput): { windowDays: number; deliveredAt: Date | null } {
  const windowDays = input.lineWindowDays ?? input.productReturnDays ?? DEFAULT_RETURN_WINDOW_DAYS;
  return { windowDays, deliveredAt: input.deliveredAt ?? input.deliveredEventAt };
}

/**
 * Throws 409 when the delivery window has closed. When no delivery timestamp is
 * on record at all (orders delivered before delivery dates were tracked), the
 * window cannot be enforced, so the request is allowed rather than blocking a
 * legitimate return for a legacy order.
 */
export function assertWithinDeliveryWindow(
  window: { windowDays: number; deliveredAt: Date | null },
  noun = 'return',
): void {
  if (!window.deliveredAt) return;
  const deadlineMs = window.deliveredAt.getTime() + window.windowDays * 24 * 60 * 60 * 1000;
  if (Date.now() > deadlineMs) {
    throw conflict(`The ${window.windowDays}-day ${noun} window for this item has closed.`);
  }
}

/**
 * The order's delivery timestamp from its event timeline. Orders record delivery
 * as a `fulfilment` event with the message `delivered: Delivered.` (see
 * advanceOrder in order.service.ts); a plain `delivered` event type is accepted
 * too, so either shape yields the timestamp. Never order.updatedAt.
 */
export async function findDeliveredEventAt(orderId: string): Promise<Date | null> {
  const event = await prisma.orderEvent.findFirst({
    where: {
      orderId,
      OR: [
        { type: 'delivered' },
        { type: 'fulfilment', message: { startsWith: 'delivered:' } },
      ],
    },
    orderBy: { at: 'asc' },
    select: { at: true },
  });
  return event?.at ?? null;
}

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

/** Shared quantity guard: the requested units must fit in what is still eligible and not already covered by a pending return. */
export function assertReturnableQty(input: {
  quantity: number;
  cancelledQty: number;
  returnedQty: number;
  pendingQty: number;
  qty: number;
}): void {
  const eligibleQty = input.quantity - input.cancelledQty - input.returnedQty;
  if (input.qty > eligibleQty) {
    throw badRequest(`Cannot return ${input.qty} — only ${eligibleQty} eligible units remain.`);
  }
  if (input.pendingQty + input.qty > eligibleQty) {
    throw conflict(`Only ${eligibleQty - input.pendingQty} units are not already covered by a pending return.`);
  }
}

async function loadReturnForCustomer(ref: string, customerId: string) {
  const row = await prisma.returnRequest.findUnique({ where: { reference: ref } });
  if (!row) throw notFound('Return request not found.');
  const order = await prisma.order.findFirst({
    where: { id: row.orderId, customerId, customerKind: 'account' },
    select: { id: true },
  });
  if (!order) throw notFound('Return request not found.');
  return toReturnRequestRow(row);
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
  const line = await prisma.orderLine.findUnique({ where: { id: input.lineId } });
  if (!line || line.orderId !== input.orderId) throw notFound('Order line not found.');

  // Return window: line override, else the product's returnDays, else the 7-day default —
  // measured from the line's deliveredAt, falling back to the order's delivered event.
  const product = await prisma.product.findUnique({
    where: { id: line.productId },
    select: { returnsAllowed: true, returnDays: true },
  });
  if (product && !product.returnsAllowed) {
    throw conflict('This product is not eligible for returns.');
  }
  const deliveredEventAt = line.deliveredAt ? null : await findDeliveredEventAt(input.orderId);
  const window = resolveDeliveryWindow({
    deliveredAt: line.deliveredAt,
    deliveredEventAt,
    lineWindowDays: line.returnWindowDays,
    productReturnDays: product?.returnDays ?? null,
  });
  assertWithinDeliveryWindow(window, 'return');

  // Quantity check (early, customer-facing); re-validated inside the transaction below.
  const activeReturns = await prisma.returnRequest.findMany({
    where: { orderLineId: input.lineId, status: { notIn: ['rejected', 'withdrawn', 'closed'] } },
    select: { requestedQty: true },
  });
  const pendingQty = activeReturns.reduce((s: number, r: { requestedQty: number }) => s + r.requestedQty, 0);
  assertReturnableQty({
    quantity: line.quantity,
    cancelledQty: line.cancelledQty,
    returnedQty: line.returnedQty,
    pendingQty,
    qty: input.qty,
  });

  // Refund the requested units' share of what was actually paid, including tax/shipping and any
  // order-level discount. For a single-line full return this is exactly order.total.
  const refundableAmount = calculateRefundableAmount({
    orderTotal: order.total,
    orderSubtotal: order.subtotal,
    lineTotal: line.lineTotal,
    lineQuantity: line.quantity,
    requestedQuantity: input.qty,
  });

  // Validate refund account ownership if provided (C9: refund_account_id is a real
  // column on the Prisma ReturnRequest model, written through the model below).
  if (input.refundAccountId) {
    const acct = await prisma.customerBankAccount.findFirst({
      where: { id: input.refundAccountId, customerId, isActive: true },
      select: { id: true },
    });
    if (!acct) {
      throw badRequest('Refund bank account not found or does not belong to you.');
    }
  }

  const id = randomHexId(12);
  const reference = generateReturnRef();
  const photosJson = JSON.stringify(input.photos ?? []);

  // One transaction: the request, the quantity reservation, the timeline event and
  // the order event land together. The quantity guard is re-checked here against
  // the freshly read line, so two concurrent requests cannot over-reserve.
  await prisma.$transaction(async (tx: any) => {
    const freshLine = await tx.orderLine.findUnique({ where: { id: input.lineId } });
    if (!freshLine) throw notFound('Order line not found.');
    const freshPending = await tx.returnRequest.findMany({
      where: { orderLineId: input.lineId, status: { notIn: ['rejected', 'withdrawn', 'closed'] } },
      select: { requestedQty: true },
    });
    assertReturnableQty({
      quantity: freshLine.quantity,
      cancelledQty: freshLine.cancelledQty,
      returnedQty: freshLine.returnedQty,
      pendingQty: freshPending.reduce((s: number, r: { requestedQty: number }) => s + r.requestedQty, 0),
      qty: input.qty,
    });

    await tx.returnRequest.create({
      data: {
        id,
        reference,
        orderId: input.orderId,
        orderLineId: input.lineId,
        variantId: line.variantId,
        requestedQty: input.qty,
        reason: input.reason,
        customerNote: input.note ?? null,
        photos: photosJson,
        status: 'requested',
        shippingMethod: input.shippingMethod ?? null,
        refundableAmount,
        returnWindowDays: window.windowDays,
        refundAccountId: input.refundAccountId ?? null,
      },
    });

    // Reserve qty
    await tx.orderLine.update({
      where: { id: input.lineId },
      data: { returnedQty: { increment: input.qty } },
    });

    // Log event
    await tx.returnEvent.create({
      data: {
        id: randomHexId(12),
        returnId: id,
        type: 'requested',
        actor: 'customer',
        actorId: customerId,
        message: `Return requested: ${input.qty} unit(s). Reason: ${input.reason}`,
      },
    });

    // Add order event
    await tx.orderEvent.create({
      data: {
        orderId: input.orderId,
        type: 'return',
        message: `Return request ${reference} submitted for ${input.qty} unit(s) of ${line.nameEn}.`,
        actor: 'customer',
      },
    });
  });

  return fetchReturnWithDetails(id);
}

export async function listCustomerReturns(customerId: string) {
  const orders = await prisma.order.findMany({
    where: { customerId, customerKind: 'account' },
    select: { id: true },
  });
  if (orders.length === 0) return [];
  const rows = await prisma.returnRequest.findMany({
    where: { orderId: { in: orders.map((o: { id: string }) => o.id) } },
    orderBy: { requestedAt: 'desc' },
  });
  return rows.map(toReturnRequestRow);
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

  await prisma.$transaction(async (tx: any) => {
    await tx.returnRequest.update({
      where: { id: row.id },
      data: { status: 'withdrawn', decidedAt: new Date() },
    });
    // Release reserved quantity (never below zero)
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
        type: 'withdrawn',
        actor: 'customer',
        actorId: customerId,
        message: 'Customer withdrew the return request.',
      },
    });
  });

  return row.reference;
}
