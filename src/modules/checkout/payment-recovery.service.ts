// Paid-but-no-order recovery (H5): the Razorpay order webhook's reconciliation side.
//
// The storefront only ever creates an order AFTER the Razorpay signature verifies, so a
// captured payment with no matching order means `POST /orders` failed after capture
// (DB error, stock race, crash). That customer is charged with no order and no stock
// move. This module records those payments — it never invents an order (the cart,
// address and totals are not in the webhook payload, so an order cannot be rebuilt
// safely) — and gives the owner a list to work through: create the order manually or
// refund from the Razorpay dashboard, then mark the row resolved with a note.
// Raw SQL, like `refunds`: the `payment_recoveries` table has no Prisma model.
import { prisma } from '../../shared/database/prisma.js';
import { notFound } from '../../shared/errors/http-error.js';
import { randomHexId } from '../../shared/utils/ids.js';

export interface CapturedPayment {
  razorpayPaymentId: string;
  razorpayOrderId: string;
  amount: number;
  currency: string;
  customerEmail: string | null;
}

export interface PaymentRecoveryRow {
  id: string;
  razorpayPaymentId: string;
  razorpayOrderId: string;
  amount: number;
  currency: string;
  customerEmail: string | null;
  status: string;
  resolutionNote: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toRecovery(r: {
  id: string; razorpay_payment_id: string; razorpay_order_id: string; amount: number; currency: string;
  customer_email: string | null; status: string; resolution_note: string | null; created_at: Date; updated_at: Date;
}): PaymentRecoveryRow {
  return {
    id: r.id,
    razorpayPaymentId: r.razorpay_payment_id,
    razorpayOrderId: r.razorpay_order_id,
    amount: Number(r.amount),
    currency: r.currency,
    customerEmail: r.customer_email,
    status: r.status,
    resolutionNote: r.resolution_note,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Reconciles one captured payment. Returns `{ matched: true }` when the payment
 * already belongs to an order (normal path — the webhook is just a second witness)
 * or to a wallet top-up (owned by the wallet webhook); otherwise records the
 * payment as `unmatched` for the owner to resolve. Idempotent: a redelivered
 * webhook refreshes the amount/email but never resets a resolved row.
 */
export async function recordCapturedPayment(p: CapturedPayment): Promise<{ matched: boolean; recoveryId: string | null; orderNumber?: string }> {
  const order = await prisma.order.findFirst({
    where: { OR: [{ paymentReference: p.razorpayPaymentId }, { razorpayOrderId: p.razorpayOrderId }] },
    select: { id: true, number: true },
  });
  if (order) return { matched: true, recoveryId: null, orderNumber: order.number };
  const topup = await prisma.walletTopup.findFirst({ where: { razorpayOrderId: p.razorpayOrderId }, select: { id: true } });
  if (topup) return { matched: true, recoveryId: null };

  const id = randomHexId(12);
  await prisma.$executeRawUnsafe(
    `INSERT INTO payment_recoveries (id, razorpay_payment_id, razorpay_order_id, amount, currency, customer_email, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'unmatched', NOW(3), NOW(3))
     ON DUPLICATE KEY UPDATE amount = VALUES(amount), currency = VALUES(currency), customer_email = VALUES(customer_email)`,
    id, p.razorpayPaymentId, p.razorpayOrderId, p.amount, p.currency, p.customerEmail,
  );
  const [row] = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id FROM payment_recoveries WHERE razorpay_payment_id = ?`,
    p.razorpayPaymentId,
  );
  return { matched: false, recoveryId: row?.id ?? id };
}

export interface FailedPayment {
  razorpayPaymentId: string;
  razorpayOrderId: string;
}

/**
 * Reconciles a `payment.failed` webhook event (C1).
 *
 * Rule, documented because it is easy to get backwards: a failed event for an order
 * that exists means the capture failed AFTER the order was created. The order's
 * payment status is set to 'failed' ONLY when the order has no successful capture
 * recorded — i.e. its paymentStatus is still 'unpaid'. An order that is 'paid' (or
 * partially refunded) reached that state only after a verified capture, so a later
 * failed event cannot undo it: it is almost certainly a duplicate, a re-attempted
 * payment, or a second payment attempt for the same order, and flipping it to
 * 'failed' would hide a paid order from fulfilment. In that case the failure is
 * recorded as an order event for the owner to investigate, and the status is left
 * alone. A failed event with no matching order needs no recovery row — no money
 * moved, so there is nothing to reconcile.
 */
export async function recordFailedPayment(p: FailedPayment): Promise<{ matched: boolean; orderNumber?: string; markedFailed: boolean }> {
  const order = await prisma.order.findFirst({
    where: { OR: [{ paymentReference: p.razorpayPaymentId }, { razorpayOrderId: p.razorpayOrderId }] },
    select: { id: true, number: true, paymentStatus: true },
  });
  if (!order) return { matched: false, markedFailed: false };
  const markedFailed = order.paymentStatus === 'unpaid';
  await prisma.$transaction(async (tx) => {
    await tx.orderEvent.create({
      data: {
        orderId: order.id,
        type: 'payment_failed',
        message: markedFailed
          ? `Payment ${p.razorpayPaymentId} failed before capture. No money was taken.`
          : `A later payment attempt ${p.razorpayPaymentId} failed, but the order was already paid — the paid status is unchanged.`,
        actor: 'system',
      },
    });
    if (markedFailed) {
      await tx.order.update({ where: { id: order.id }, data: { paymentStatus: 'failed' } });
    }
  });
  return { matched: true, orderNumber: order.number, markedFailed };
}

/** Newest-first recovery list for the admin (unmatched first is the default view). */
export async function listPaymentRecoveries(status?: string): Promise<PaymentRecoveryRow[]> {
  const rows = status
    ? await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`SELECT * FROM payment_recoveries WHERE status = ? ORDER BY created_at DESC LIMIT 100`, status)
    : await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`SELECT * FROM payment_recoveries ORDER BY (status = 'unmatched') DESC, created_at DESC LIMIT 100`);
  return rows.map((r) => toRecovery(r as never));
}

/** Marks a recovery resolved once the owner has created the order or refunded the payment. */
export async function resolvePaymentRecovery(id: string, note: string, actorEmail: string): Promise<PaymentRecoveryRow> {
  const [row] = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`SELECT * FROM payment_recoveries WHERE id = ?`, id);
  if (!row) throw notFound('Payment recovery not found.');
  await prisma.$executeRawUnsafe(
    `UPDATE payment_recoveries SET status = 'resolved', resolution_note = ?, updated_at = NOW(3) WHERE id = ?`,
    `${note} (resolved by ${actorEmail})`,
    id,
  );
  const [updated] = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`SELECT * FROM payment_recoveries WHERE id = ?`, id);
  return toRecovery(updated as never);
}
