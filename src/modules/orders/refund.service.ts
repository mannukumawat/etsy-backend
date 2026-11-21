import type { Prisma } from '@prisma/client';
import { prisma } from '../../shared/database/prisma.js';
import { badRequest, conflict, HttpError, notFound } from '../../shared/errors/http-error.js';
import { randomHexId } from '../../shared/utils/ids.js';
import { isRazorpayConfigured, refundRazorpayPayment, type GatewayRefund } from '../checkout/payment.service.js';
import type { RefundRow } from '../returns/return.types.js';
import { creditWallet } from '../wallet/wallet.service.js';

// Real refunds (C7) — the ONE place that talks to Razorpay for refunds and the ONE
// place that writes `refunds` rows. Order refunds, order cancellations with a refund
// and return refunds all go through here, so the gateway rules can never drift:
//   * 'original' refunds call Razorpay and are only marked completed after the
//     gateway confirms (status 'processed'); the money moves in the SAME currency
//     and method as the original charge — amounts are never converted.
//   * Manual bank/UPI refunds are recorded as 'pending' with a reference and only
//     move the order totals when an admin verifies them (verifyManualRefund).
//   * Store-credit refunds credit the wallet atomically, like return refunds do.
// A refund row is always written BEFORE money moves, so a failure mid-flight leaves
// a traceable 'pending'/'failed' row instead of silent ledger drift.
//
// The `refunds` table has a Prisma model (Refund) — all reads/writes below go through
// it, not raw SQL, so the over-refund guard and the row state stay in one place.

export type RefundMethod = 'original' | 'manual_bank' | 'manual_upi' | 'store_credit';

export interface RefundInput {
  amount: number;
  reason: string;
  method: RefundMethod;
  reference?: string;
  note?: string;
}

/** Injectable gateway call so tests can stub Razorpay without credentials. */
export type GatewayRefundFn = (
  razorpayPaymentId: string,
  amountMinor: number,
  notes?: Record<string, string>,
) => Promise<GatewayRefund>;

export interface RefundDeps {
  gatewayRefund?: GatewayRefundFn;
}

export interface OrderRefundView {
  id: string;
  orderId: string;
  returnId: string | null;
  amount: number;
  reason: string;
  method: string;
  status: string;
  reference: string | null;
  completedAt: string | null;
  failedAt: string | null;
  recordedBy: string | null;
  note: string | null;
  createdAt: string;
}

export function toRefundView(row: RefundRow): OrderRefundView {
  return {
    id: row.id,
    orderId: row.order_id,
    returnId: row.return_id,
    amount: row.amount,
    reason: row.reason,
    method: row.method,
    status: row.status,
    reference: row.reference,
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
    failedAt: row.failed_at ? new Date(row.failed_at).toISOString() : null,
    recordedBy: row.recorded_by,
    note: row.note,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

type Db = Prisma.TransactionClient | typeof prisma;

/** Prisma `refund` rows are camelCase; the shared RefundRow shape is snake_case. */
function toRefundRow(r: {
  id: string; orderId: string; returnId: string | null; amount: number; reason: string;
  method: string; status: string; reference: string | null; completedAt: Date | null;
  failedAt: Date | null; recordedBy: string | null; note: string | null;
  createdAt: Date; updatedAt: Date;
}): RefundRow {
  return {
    id: r.id,
    order_id: r.orderId,
    return_id: r.returnId,
    amount: r.amount,
    reason: r.reason,
    method: r.method,
    status: r.status,
    reference: r.reference,
    completed_at: r.completedAt,
    failed_at: r.failedAt,
    recorded_by: r.recordedBy,
    note: r.note,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
}

export async function insertRefundRow(
  db: Db,
  row: { id: string; orderId: string; returnId: string | null; amount: number; reason: string; method: string; status: string; reference: string | null; recordedBy: string | null; note: string | null },
) {
  await db.refund.create({
    data: {
      id: row.id,
      orderId: row.orderId,
      returnId: row.returnId,
      amount: row.amount,
      reason: row.reason,
      method: row.method,
      status: row.status,
      reference: row.reference,
      recordedBy: row.recordedBy,
      note: row.note,
    },
  });
}

async function updateRefundRow(
  db: Db,
  id: string,
  fields: { status?: string; reference?: string | null; completedAt?: Date | null; failedAt?: Date | null; note?: string | null },
) {
  const data: {
    status?: string; reference?: string | null; completedAt?: Date | null; failedAt?: Date | null; note?: string | null;
  } = {};
  if (fields.status !== undefined) data.status = fields.status;
  if (fields.reference !== undefined) data.reference = fields.reference;
  if (fields.completedAt !== undefined) data.completedAt = fields.completedAt;
  if (fields.failedAt !== undefined) data.failedAt = fields.failedAt;
  if (fields.note !== undefined) data.note = fields.note;
  if (!Object.keys(data).length) return;
  await db.refund.update({ where: { id }, data });
}

export async function findRefundById(id: string): Promise<RefundRow | null> {
  const row = await prisma.refund.findUnique({ where: { id } });
  return row ? toRefundRow(row) : null;
}

/** All refunds for the given orders, in one query (no N+1 per order). */
export async function listRefundsForOrders(orderIds: string[]): Promise<Map<string, OrderRefundView[]>> {
  const byOrder = new Map<string, OrderRefundView[]>();
  if (!orderIds.length) return byOrder;
  const rows = await prisma.refund.findMany({
    where: { orderId: { in: orderIds } },
    orderBy: { createdAt: 'asc' },
  });
  for (const row of rows) {
    const view = toRefundView(toRefundRow(row));
    if (!byOrder.has(view.orderId)) byOrder.set(view.orderId, []);
    byOrder.get(view.orderId)!.push(view);
  }
  return byOrder;
}

/**
 * Applies a confirmed refund to the order totals with an atomic over-refund guard:
 * the update only lands when refundedTotal + amount still fits inside the total, so
 * two concurrent refunds can never push refundedTotal past the total. Must run
 * inside the same transaction as the refund-row update.
 */
export async function applyOrderRefundTotals(
  tx: Prisma.TransactionClient,
  order: { id: string; number: string; total: number; refundedTotal: number; currency: string },
  amount: number,
  eventMessage: string,
) {
  const newRefundedTotal = order.refundedTotal + amount;
  const newPaymentStatus = newRefundedTotal >= order.total ? 'refunded' : 'partially_refunded';
  const updated = await tx.order.updateMany({
    where: { id: order.id, refundedTotal: { lte: order.total - amount } },
    data: { refundedTotal: newRefundedTotal, paymentStatus: newPaymentStatus },
  });
  if (updated.count === 0) {
    throw conflict('Refund amount would exceed the order total. Possible concurrent refund.');
  }
  await tx.orderEvent.create({
    data: { orderId: order.id, type: 'refund', message: eventMessage, actor: 'admin' },
  });
}

export function refundableOf(order: { total: number; refundedTotal: number; paymentStatus: string }): number {
  return ['paid', 'partially_refunded'].includes(order.paymentStatus)
    ? Math.max(0, order.total - order.refundedTotal)
    : 0;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Runs a Razorpay refund for an order/return and records it. The row starts 'pending',
 * the gateway is called, and the gateway refund id is stored on the row immediately —
 * so even if the caller's transaction fails afterwards, the row stays traceable.
 * The caller completes the row (and the order totals) inside its own transaction via
 * completeRefundRow. Throws 502 on gateway failure, after marking the row 'failed'.
 */
export async function runGatewayRefund(
  args: { orderId: string; orderNumber: string; returnId: string | null; amount: number; reason: string; actorEmail: string },
  order: { paymentReference: string | null },
  deps?: RefundDeps,
): Promise<{ refundId: string; gateway: GatewayRefund }> {
  if (!order.paymentReference) {
    throw conflict(
      'This order has no stored Razorpay payment reference, so the refund cannot be sent automatically. ' +
        'Record a manual refund with the bank/UPI reference instead.',
    );
  }
  if (!isRazorpayConfigured()) {
    throw conflict('Razorpay is not configured, so the refund cannot be sent automatically. Record a manual refund instead.');
  }
  const refundId = randomHexId(12);
  await insertRefundRow(prisma, {
    id: refundId,
    orderId: args.orderId,
    returnId: args.returnId,
    amount: args.amount,
    reason: args.reason,
    method: 'original',
    status: 'pending',
    reference: null,
    recordedBy: args.actorEmail,
    note: null,
  });
  let gateway: GatewayRefund;
  try {
    const fn = deps?.gatewayRefund ?? refundRazorpayPayment;
    gateway = await fn(order.paymentReference, args.amount, { order: args.orderNumber, reason: args.reason });
  } catch (e) {
    await updateRefundRow(prisma, refundId, { status: 'failed', failedAt: new Date(), note: errorText(e).slice(0, 500) });
    throw new HttpError(
      502,
      'gateway_error',
      `Razorpay refused the refund (${errorText(e)}). No money was moved — try again or record a manual refund.`,
    );
  }
  await updateRefundRow(prisma, refundId, { reference: gateway.id });
  return { refundId, gateway };
}

/**
 * Marks a gateway refund row completed (only when the gateway reported 'processed')
 * — or 'processing' when the gateway accepted it but has not settled it yet. This
 * only touches the row; the caller moves the order totals (applyOrderRefundTotals)
 * when the refund actually completed.
 */
export async function completeRefundRow(
  tx: Prisma.TransactionClient,
  refundId: string,
  gateway: GatewayRefund,
): Promise<'completed' | 'processing'> {
  if (gateway.status === 'processed') {
    await updateRefundRow(tx, refundId, { status: 'completed', completedAt: new Date() });
    return 'completed';
  }
  await updateRefundRow(tx, refundId, { status: 'processing' });
  return 'processing';
}

export interface OrderLike {
  id: string;
  number: string;
  total: number;
  refundedTotal: number;
  paymentStatus: string;
  paymentMethod: string;
  /** Razorpay payment id; null for full-wallet orders (which have no gateway payment). */
  paymentReference: string | null;
  currency: string;
  customerId: string | null;
}

/**
 * Direct order refund (POST /api/admin/orders/:id/refund). 'original' goes through
 * Razorpay; 'store_credit' credits the wallet; manual methods record a 'pending'
 * refund that only affects the totals once verified (verifyManualRefund).
 */
export async function issueOrderRefund(
  order: OrderLike,
  input: RefundInput,
  actorEmail: string,
  deps?: RefundDeps,
): Promise<OrderRefundView> {
  if (!['paid', 'partially_refunded'].includes(order.paymentStatus)) {
    throw conflict('This order has not been paid, so it cannot be refunded.');
  }
  const remaining = order.total - order.refundedTotal;
  if (input.amount > remaining) {
    throw badRequest(`Cannot refund more than the remaining ${remaining}.`, [{ path: 'amount', message: 'Too high.' }]);
  }

  if (input.method === 'original') {
    if (order.paymentMethod === 'wallet') {
      throw badRequest('This order was paid from the wallet, so there is no card/UPI payment to refund. Use store credit instead.');
    }
    const { refundId, gateway } = await runGatewayRefund(
      { orderId: order.id, orderNumber: order.number, returnId: null, amount: input.amount, reason: input.reason, actorEmail },
      order,
      deps,
    );
    const eventMessage =
      gateway.status === 'processed'
        ? `Refunded ${input.amount} ${order.currency} via Razorpay (refund ${gateway.id})${input.reason ? `: ${input.reason}` : '.'}`
        : `Razorpay refund ${gateway.id} is processing (${input.amount} ${order.currency}). Totals will update once it settles.`;
    await prisma.$transaction(async (tx) => {
      const state = await completeRefundRow(tx, refundId, gateway);
      if (state === 'completed') {
        await applyOrderRefundTotals(tx, order, input.amount, eventMessage);
      } else {
        await tx.orderEvent.create({
          data: { orderId: order.id, type: 'refund', message: eventMessage, actor: 'admin' },
        });
      }
    });
    const row = await findRefundById(refundId);
    return toRefundView(row!);
  }

  if (input.method === 'store_credit') {
    if (!order.customerId) {
      throw badRequest('Cannot issue a store-credit refund for a guest order.');
    }
    const refundId = randomHexId(12);
    const walletRef = `refund:order:${refundId}`;
    await prisma.$transaction(async (tx) => {
      await insertRefundRow(tx, {
        id: refundId,
        orderId: order.id,
        returnId: null,
        amount: input.amount,
        reason: input.reason,
        method: 'store_credit',
        status: 'completed',
        reference: walletRef,
        recordedBy: actorEmail,
        note: input.note ?? null,
      });
      await creditWallet(order.customerId!, input.amount, 'refund', walletRef, { orderId: order.id, tx });
      await applyOrderRefundTotals(
        tx,
        order,
        input.amount,
        `Refunded ${input.amount} ${order.currency} to the customer wallet${input.reason ? `: ${input.reason}` : '.'}`,
      );
      await updateRefundRow(tx, refundId, { completedAt: new Date() });
    });
    const row = await findRefundById(refundId);
    return toRefundView(row!);
  }

  // Manual bank/UPI: reference is mandatory, and the refund stays 'pending' — the
  // order totals do not move until an admin verifies the money actually arrived.
  if (!input.reference?.trim()) {
    throw badRequest('A bank/UPI reference is required for a manual refund.', [{ path: 'reference', message: 'Required.' }]);
  }
  const refundId = randomHexId(12);
  await insertRefundRow(prisma, {
    id: refundId,
    orderId: order.id,
    returnId: null,
    amount: input.amount,
    reason: input.reason,
    method: input.method,
    status: 'pending',
    reference: input.reference.trim(),
    recordedBy: actorEmail,
    note: input.note ?? null,
  });
  const row = await findRefundById(refundId);
  return toRefundView(row!);
}

/**
 * Verifies a pending manual refund (bank/UPI): marks it completed and only then
 * moves the order totals. The completion/verification step manual refunds were missing.
 */
export async function verifyManualRefund(refundId: string): Promise<OrderRefundView> {
  const row = await findRefundById(refundId);
  if (!row) throw notFound('Refund not found.');
  if (row.return_id) {
    throw badRequest('This refund belongs to a return. Verify it from the return instead.');
  }
  if (!['manual_bank', 'manual_upi'].includes(row.method)) {
    throw badRequest('Only manual bank/UPI refunds need verification.');
  }
  if (row.status !== 'pending') {
    throw conflict(`This refund is already '${row.status}'.`);
  }
  const order = await prisma.order.findUnique({ where: { id: row.order_id } });
  if (!order) throw notFound('Order not found.');
  await prisma.$transaction(async (tx) => {
    await updateRefundRow(tx, refundId, { status: 'completed', completedAt: new Date() });
    await applyOrderRefundTotals(
      tx,
      order,
      row.amount,
      `Manual refund of ${row.amount} ${order.currency} verified (ref ${row.reference ?? '—'}).`,
    );
  });
  const updated = await findRefundById(refundId);
  return toRefundView(updated!);
}
