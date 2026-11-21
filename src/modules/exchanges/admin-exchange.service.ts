import { prisma } from '../../shared/database/prisma.js';
import { conflict, notFound } from '../../shared/errors/http-error.js';
import { randomHexId } from '../../shared/utils/ids.js';
import { adjustmentData } from '../../shared/utils/inventory-adjustments.js';
import { emitLowStockIfCrossed } from '../inventory/low-stock-alert.js';
import { issueOrderRefund, refundableOf, type OrderLike } from '../orders/refund.service.js';
import { addExchangeEvent, fetchExchangeWithEvents, toExchangeRequestRow, type ExchangeRequestModel } from './exchange.repository.js';
import type { ApproveExchangeInput, RecordPaymentInput, RejectExchangeInput, ShipExchangeInput } from './exchange.schema.js';
import type { ExchangeRequestRow, OwnerActor } from './exchange.types.js';

// Owner-side exchange workflow: requested -> approved -> shipped -> delivered -> closed (or rejected).
// Backed by the Prisma ExchangeRequest / ExchangeEvent models.
//
// Price difference (H16): the difference is computed from converted prices at
// request time (see exchange.service.ts) and settled at ship time — a negative
// difference is refunded automatically, a positive difference blocks shipping
// until the owner records the payment (recordExchangePayment). Refunds go back
// in the same currency and method as the original charge, via
// refund.service's issueOrderRefund — this file writes no refund rows itself.

async function loadExchangeOr404(id: string) {
  const row = await prisma.exchangeRequest.findUnique({ where: { id } });
  if (!row) throw notFound('Exchange request not found.');
  return toExchangeRequestRow(row);
}

function assertExchangeStatus(row: ExchangeRequestRow, expected: string) {
  if (row.status !== expected) {
    throw conflict(`Expected status '${expected}', got '${row.status}'.`);
  }
}

/** Has the owner recorded the payment for a positive price difference? */
async function hasPaymentRecorded(exchangeId: string): Promise<boolean> {
  const event = await prisma.exchangeEvent.findFirst({
    where: { exchangeId, type: 'payment_recorded' },
    select: { id: true },
  });
  return !!event;
}

/**
 * Amount still due from the customer for this exchange, in the order currency's
 * minor units: the positive price difference, unless its payment was recorded.
 * (The admin mapper applies the same rule from the event timeline; see
 * exchange.mapper.ts toAdminExchange.)
 */
export function exchangeAmountDue(priceDifference: number, paymentRecorded: boolean): number {
  return priceDifference > 0 && !paymentRecorded ? priceDifference : 0;
}

/** M-O10: paginated list (was: unpaged LIMIT 200) so the admin exchanges page can
 *  page like every other list. */
export async function listExchanges(status: string | undefined, page = 1, pageSize = 20) {
  const safePageSize = Math.min(100, Math.max(1, pageSize));
  const where = status ? { status } : {};
  const total = await prisma.exchangeRequest.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / safePageSize));
  const safePage = Math.min(Math.max(1, page), pageCount);
  const rows = await prisma.exchangeRequest.findMany({
    where,
    orderBy: { requestedAt: 'desc' },
    take: safePageSize,
    skip: (safePage - 1) * safePageSize,
  });
  // Amount due per row, from one batched event query (no N+1): a row owes its
  // positive price difference unless a payment was recorded for it.
  const ids = rows.map((r: ExchangeRequestModel) => r.id);
  const paymentEvents = ids.length
    ? await prisma.exchangeEvent.findMany({
        where: { exchangeId: { in: ids }, type: 'payment_recorded' },
        select: { exchangeId: true },
      })
    : [];
  const paidIds = new Set(paymentEvents.map((e: { exchangeId: string }) => e.exchangeId));
  const amountDueById: Record<string, number> = {};
  for (const r of rows as ExchangeRequestModel[]) {
    amountDueById[r.id] = exchangeAmountDue(r.priceDifference, paidIds.has(r.id));
  }
  return { rows: rows.map(toExchangeRequestRow), total, page: safePage, pageSize: safePageSize, pageCount, amountDueById };
}

export async function getExchangeDetail(id: string) {
  const row = await loadExchangeOr404(id);
  const { events } = await fetchExchangeWithEvents(row.id);
  return { row, events };
}

export async function approveExchange(id: string, input: ApproveExchangeInput, actor: OwnerActor) {
  const row = await loadExchangeOr404(id);
  assertExchangeStatus(row, 'requested');

  // Check replacement stock
  const variant = await prisma.productVariant.findUnique({
    where: { id: row.replacement_variant_id },
    select: { stock: true },
  });
  if (!variant || variant.stock < input.approvedQty) {
    throw conflict('Insufficient replacement stock to approve this exchange.');
  }

  await prisma.exchangeRequest.update({
    where: { id: row.id },
    data: { status: 'approved', approvedQty: input.approvedQty, decidedAt: new Date() },
  });
  await addExchangeEvent(row.id, 'approved', 'admin', `Approved for ${input.approvedQty} unit(s).${input.note ? ' ' + input.note : ''}`, actor.id);

  return fetchExchangeWithEvents(row.id);
}

export async function rejectExchange(id: string, input: RejectExchangeInput, actor: OwnerActor) {
  const row = await loadExchangeOr404(id);
  if (!['requested', 'approved'].includes(row.status)) {
    throw conflict(`Cannot reject from status '${row.status}'.`);
  }

  await prisma.$transaction(async (tx: any) => {
    // Release reserved qty
    const line = await tx.orderLine.findUnique({
      where: { id: row.order_line_id },
      select: { exchangedQty: true },
    });
    if (line) {
      await tx.orderLine.update({
        where: { id: row.order_line_id },
        data: { exchangedQty: Math.max(0, line.exchangedQty - row.requested_qty) },
      });
    }
    await tx.exchangeRequest.update({
      where: { id: row.id },
      data: { status: 'rejected', rejectionReason: input.reason, decidedAt: new Date() },
    });
    await tx.exchangeEvent.create({
      data: {
        id: randomHexId(12),
        exchangeId: row.id,
        type: 'rejected',
        actor: 'admin',
        actorId: actor.id,
        message: `Rejected: ${input.reason}`,
      },
    });
  });

  return fetchExchangeWithEvents(row.id);
}

/**
 * Records the customer's payment of a positive price difference. The reference
 * and note are stored as a `payment_recorded` exchange event, which clears the
 * amount due (see exchangeAmountDue) and unblocks shipping. One payment per
 * exchange: a second recording is rejected.
 */
export async function recordExchangePayment(id: string, input: RecordPaymentInput, actor: OwnerActor) {
  const row = await loadExchangeOr404(id);
  if (!['requested', 'approved'].includes(row.status)) {
    throw conflict(`Cannot record a payment when status is '${row.status}'.`);
  }
  if (row.price_difference <= 0) {
    throw conflict('No price difference is due for this exchange, so there is no payment to record.');
  }
  if (await hasPaymentRecorded(row.id)) {
    throw conflict('A payment for this price difference has already been recorded.');
  }
  const order = await prisma.order.findUnique({ where: { id: row.order_id }, select: { currency: true } });
  const currency = order?.currency ?? '';
  await addExchangeEvent(
    row.id,
    'payment_recorded',
    'admin',
    `Payment of ${row.price_difference} ${currency} recorded (reference: ${input.reference}).${input.note ? ' ' + input.note : ''}`,
    actor.id,
  );
  return fetchExchangeWithEvents(row.id);
}

/**
 * Refunds a negative price difference (the customer overpaid) when the exchange
 * ships. The refund goes back in the same currency and method as the original
 * charge — gateway orders via Razorpay, wallet orders as store credit — through
 * refund.service's issueOrderRefund, and is never converted. The
 * `refund_issued` event marks it done, so a retried shipment can never refund
 * the same difference twice. Throws when the refund cannot be issued, so the
 * exchange is never shipped with money still owed to the customer.
 */
async function refundNegativeDifference(
  row: ExchangeRequestRow,
  order: { id: string; number: string; total: number; refundedTotal: number; paymentStatus: string; paymentMethod: string; paymentReference: string | null; currency: string; customerId: string | null },
  actor: OwnerActor,
): Promise<void> {
  const alreadyRefunded = await prisma.exchangeEvent.findFirst({
    where: { exchangeId: row.id, type: 'refund_issued' },
    select: { id: true },
  });
  if (alreadyRefunded) return;

  // Never refund more than the order can still give back (a prior refund may
  // already have used part of the total).
  const refundAmount = Math.min(-row.price_difference, refundableOf(order));
  if (refundAmount <= 0) return;

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
  const method = order.paymentMethod === 'wallet' ? 'store_credit' : 'original';
  const view = await issueOrderRefund(
    orderLike,
    { amount: refundAmount, reason: `Exchange ${row.reference}: refund of the price difference`, method },
    actor.email,
  );
  await addExchangeEvent(
    row.id,
    'refund_issued',
    'admin',
    `Refunded ${refundAmount} ${order.currency} for the price difference via ${method === 'original' ? 'Razorpay' : 'store credit'} (refund ${view.reference ?? view.id}).`,
    actor.id,
  );
}

/**
 * Records the replacement shipment and deducts the replacement variant's stock — all
 * in ONE transaction (H4). Stock is re-checked at ship time (the approve-time check
 * is stale by now) with a conditional decrement: insufficient stock REJECTS the
 * shipment instead of clamping to zero, and the history row records the ACTUAL
 * delta deducted (before − qty), never the full approved qty when less was taken.
 * A failure anywhere rolls the deduction, the history row and the status update back
 * together, so a shipped-again exchange can never double-deduct.
 *
 * The price difference is settled before shipping (H16): a positive difference
 * blocks shipping until its payment is recorded; a negative difference is
 * refunded first (see refundNegativeDifference).
 */
export async function shipExchange(id: string, input: ShipExchangeInput, actor: OwnerActor) {
  const row = await loadExchangeOr404(id);
  assertExchangeStatus(row, 'approved');
  const qty = row.approved_qty ?? row.requested_qty;

  const order = await prisma.order.findUnique({ where: { id: row.order_id } });
  if (!order) throw notFound('Order not found.');

  if (row.price_difference > 0) {
    if (!(await hasPaymentRecorded(row.id))) {
      throw conflict(`A price difference of ${row.price_difference} ${order.currency} is still due — record the payment first.`);
    }
  } else if (row.price_difference < 0) {
    await refundNegativeDifference(row, order, actor);
  }

  const variant = await prisma.productVariant.findUnique({
    where: { id: row.replacement_variant_id },
    select: { stock: true, sku: true, product: { select: { id: true, nameEn: true, nameHi: true } } },
  });
  if (!variant) throw conflict('The replacement variant no longer exists, so this exchange cannot be shipped.');
  if (variant.stock < qty) {
    throw conflict(`Only ${variant.stock} unit(s) of the replacement are in stock, but ${qty} were approved. Restock or reject the exchange first.`);
  }

  await prisma.$transaction(async (tx: any) => {
    const before = variant.stock;
    const after = before - qty;
    const deducted = await tx.productVariant.updateMany({
      where: { id: row.replacement_variant_id, stock: { gte: qty } },
      data: { stock: after },
    });
    if (deducted.count === 0) throw conflict('Replacement stock changed while shipping. Refresh and try again.');
    await tx.inventoryAdjustment.create({
      data: adjustmentData({
        productId: variant.product.id,
        variantId: row.replacement_variant_id,
        sku: variant.sku,
        productNameEn: variant.product.nameEn,
        productNameHi: variant.product.nameHi,
        variantLabel: '',
        before,
        after,
        reason: 'exchange_shipped',
        note: `Exchange ${row.reference} replacement shipped.`,
        actor: actor.email,
      }),
    });
    // Guarded by status so a concurrent shipment cannot ship the same exchange twice.
    const shipped = await tx.exchangeRequest.updateMany({
      where: { id: row.id, status: 'approved' },
      data: {
        status: 'shipped',
        replacementCarrier: input.carrier,
        replacementTracking: input.tracking,
        shippedAt: new Date(),
      },
    });
    if (shipped.count === 0) throw conflict('This exchange is no longer awaiting shipment. Refresh and try again.');
  });
  await addExchangeEvent(row.id, 'shipped', 'admin', `Replacement shipped via ${input.carrier} (${input.tracking}).`, actor.id);
  // M-I5: shipping the replacement can push it down through the low-stock threshold.
  void emitLowStockIfCrossed(row.replacement_variant_id, variant.stock, variant.stock - qty);

  return fetchExchangeWithEvents(row.id);
}

/**
 * Puts the ORIGINAL variant back into stock when an exchange completes. Runs
 * inside the caller's transaction, next to the status update, so stock and
 * status can never drift apart. Idempotent: the `original_restocked` event
 * marks it done, so delivering and then closing the same exchange restocks
 * exactly once. A missing variant or line is reported in the result instead of
 * failing the completion — the units simply could not be restocked.
 *
 * `tx` is left untyped on purpose: the generated TransactionClient type only
 * exists after `prisma generate` succeeds, which this environment cannot do;
 * the behaviour is covered by the mocked unit tests instead.
 */
async function restockOriginalVariant(
  tx: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  row: ExchangeRequestRow,
  actor: OwnerActor,
): Promise<{ restocked: number; skipped: boolean }> {
  const already = await tx.exchangeEvent.findFirst({
    where: { exchangeId: row.id, type: 'original_restocked' },
    select: { id: true },
  });
  if (already) return { restocked: 0, skipped: false };

  const qty = row.approved_qty ?? row.requested_qty;
  const line = await tx.orderLine.findUnique({
    where: { id: row.order_line_id },
    select: { variantId: true, sku: true, variantLabelEn: true },
  });
  if (!line) return { restocked: 0, skipped: true };
  const variant = await tx.productVariant.findUnique({
    where: { id: line.variantId },
    select: { stock: true, product: { select: { id: true, nameEn: true, nameHi: true } } },
  });
  if (!variant) return { restocked: 0, skipped: true };

  const updated = await tx.productVariant.updateMany({
    where: { id: line.variantId },
    data: { stock: { increment: qty } },
  });
  if (updated.count === 0) return { restocked: 0, skipped: true };
  const afterRow = await tx.productVariant.findUnique({ where: { id: line.variantId }, select: { stock: true } });
  const after = afterRow?.stock ?? variant.stock + qty;
  const before = after - qty;
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
      reason: 'exchange_completed',
      note: `Exchange ${row.reference}: original variant restocked (${qty} unit(s)).`,
      actor: actor.email,
    }),
  });
  await tx.exchangeEvent.create({
    data: {
      id: randomHexId(12),
      exchangeId: row.id,
      type: 'original_restocked',
      actor: 'admin',
      actorId: actor.id,
      message: `Original variant restocked: ${qty} unit(s).`,
    },
  });
  return { restocked: qty, skipped: false };
}

export async function markExchangeDelivered(id: string, actor: OwnerActor) {
  const row = await loadExchangeOr404(id);
  assertExchangeStatus(row, 'shipped');

  const { restocked, skipped } = await prisma.$transaction(async (tx: any) => {
    await tx.exchangeRequest.update({
      where: { id: row.id },
      data: { status: 'delivered', deliveredAt: new Date() },
    });
    return restockOriginalVariant(tx, row, actor);
  });
  await addExchangeEvent(
    row.id,
    'delivered',
    'admin',
    `Replacement delivered to customer.${restocked ? ` Original variant restocked (${restocked} unit(s)).` : ''}${skipped ? ' Note: the original variant no longer exists, so it could not be restocked.' : ''}`,
    actor.id,
  );

  return fetchExchangeWithEvents(row.id);
}

export async function closeExchange(id: string, actor: OwnerActor) {
  const row = await loadExchangeOr404(id);
  if (!['delivered', 'approved'].includes(row.status)) {
    throw conflict(`Cannot close from status '${row.status}'.`);
  }

  // Closing from 'delivered' finalises a completed exchange; closing from
  // 'approved' abandons it before anything shipped, so nothing is restocked.
  const { restocked, skipped } = await prisma.$transaction(async (tx: any) => {
    await tx.exchangeRequest.update({
      where: { id: row.id },
      data: { status: 'closed', closedAt: new Date() },
    });
    if (row.status === 'delivered') {
      return restockOriginalVariant(tx, row, actor);
    }
    return { restocked: 0, skipped: false };
  });
  await addExchangeEvent(
    row.id,
    'closed',
    'admin',
    `Exchange request closed.${restocked ? ` Original variant restocked (${restocked} unit(s)).` : ''}${skipped ? ' Note: the original variant no longer exists, so it could not be restocked.' : ''}`,
    actor.id,
  );

  return fetchExchangeWithEvents(row.id);
}
