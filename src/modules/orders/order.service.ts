import type { Prisma } from '@prisma/client';
import { prisma } from '../../shared/database/prisma.js';
import { badRequest, conflict, notFound } from '../../shared/errors/http-error.js';
import { clampPage, pageCountFor } from '../../shared/utils/pagination.js';
import { randomHexId } from '../../shared/utils/ids.js';
import { loadLineExtras } from './order-line-extras.service.js';
import { ORDER_INCLUDE } from './order.mapper.js';
import type { AddNoteInput, AdvanceOrderInput, CancelOrderInput, RefundOrderInput, UpdateTrackingInput } from './order.schema.js';
import {
  completeRefundRow,
  insertRefundRow,
  issueOrderRefund,
  listRefundsForOrders,
  refundableOf,
  runGatewayRefund,
  type RefundDeps,
} from './refund.service.js';
import type { GatewayRefund } from '../checkout/payment.service.js';
import { creditWallet } from '../wallet/wallet.service.js';

// Owner-only order management. The fulfilment state machine (unfulfilled -> processing -> shipped ->
// delivered, with cancel only before shipping) and the payment rules (advance only while paid, cancel
// restocks exactly once) mirror admin/src/utils/orderRules.ts exactly.

const FULFILMENT_ORDER = ['unfulfilled', 'processing', 'shipped', 'delivered'] as const;

export type OrderListSort = 'date' | 'total' | 'number';

export interface OrderListQuery {
  q: string;
  /** Fulfilment status filter. */
  status: string;
  /** Payment status filter. */
  payment: string;
  currency: string;
  /** Customer kind filter: 'account' | 'guest'. */
  customer: string;
  /** Inclusive date range (YYYY-MM-DD). */
  from: string;
  to: string;
  /** Paid but not yet shipped. */
  pending: boolean;
  /** Successfully paid (paid / partially refunded / refunded). */
  paidOnly: boolean;
  sort: OrderListSort;
  dir: 'asc' | 'desc';
  page: number;
  pageSize: number;
}

/**
 * Server-side orders list: filters, sort and pagination all happen in the database —
 * the old `take: 500` silent cap is gone. One WHERE builder feeds both the count and
 * the page query, so the two can never disagree about which orders match.
 *
 * Sort by total compares USD equivalents (the admin's documented meaning): the total
 * is divided by the order's own checkout rate from its stored rate snapshot
 * (`rateSnapshotJson.rates[<currency>]`). Date/number sorts are plain column sorts.
 */
function buildOrderListWhere(query: OrderListQuery): { sql: string; params: unknown[] } {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (query.status) {
    conds.push('fulfilmentStatus = ?');
    params.push(query.status);
  }
  if (query.payment) {
    conds.push('paymentStatus = ?');
    params.push(query.payment);
  }
  if (query.currency) {
    conds.push('currency = ?');
    params.push(query.currency);
  }
  if (query.customer) {
    conds.push('customerKind = ?');
    params.push(query.customer);
  }
  if (query.from) {
    conds.push('createdAt >= ?');
    params.push(`${query.from} 00:00:00`);
  }
  if (query.to) {
    conds.push('createdAt < DATE_ADD(?, INTERVAL 1 DAY)');
    params.push(query.to);
  }
  if (query.pending) {
    conds.push(`paymentStatus IN ('paid', 'partially_refunded')`);
    conds.push(`fulfilmentStatus IN ('unfulfilled', 'processing')`);
  }
  if (query.paidOnly) {
    conds.push(`paymentStatus IN ('paid', 'partially_refunded', 'refunded')`);
  }
  if (query.q) {
    // Escape LIKE wildcards in the search text so '%'/'_' match literally.
    const like = `%${query.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    conds.push('(number LIKE ? ESCAPE \'\\\' OR customerEmail LIKE ? ESCAPE \'\\\' OR customerName LIKE ? ESCAPE \'\\\')');
    params.push(like, like, like);
  }
  return { sql: conds.length ? `WHERE ${conds.join(' AND ')}` : '', params };
}

/** ORDER BY fragments; sort keys are whitelisted by the route, never interpolated raw. */
const ORDER_SORT_SQL: Record<OrderListSort, string> = {
  date: 'createdAt',
  number: 'number',
  total: `(total / COALESCE(NULLIF(CAST(JSON_UNQUOTE(JSON_EXTRACT(rateSnapshotJson, CONCAT('$.rates."', currency, '"'))) AS DECIMAL(20, 8)), 0), 1))`,
};

export async function listOrders(query: OrderListQuery) {
  const { sql, params } = buildOrderListWhere(query);
  const totalRows = await prisma.$queryRawUnsafe<Array<{ total: number }>>(
    `SELECT COUNT(*) as total FROM orders ${sql}`,
    ...params,
  );
  const total = Number(totalRows[0]?.total ?? 0);
  const pageSize = Math.max(1, query.pageSize);
  const pageCount = pageCountFor(total, pageSize);
  const page = clampPage(query.page, pageCount);
  const sortSql = ORDER_SORT_SQL[query.sort] ?? ORDER_SORT_SQL.date;
  const dir = query.dir === 'asc' ? 'ASC' : 'DESC';
  const idRows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id FROM orders ${sql} ORDER BY ${sortSql} ${dir} LIMIT ? OFFSET ?`,
    ...params,
    pageSize,
    (page - 1) * pageSize,
  );
  const ids = idRows.map((r) => r.id);
  const rows = ids.length
    ? await prisma.order.findMany({ where: { id: { in: ids } }, include: ORDER_INCLUDE })
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = ids.map((id) => byId.get(id)!).filter(Boolean);
  const extras = await loadLineExtras(ids);
  const refunds = await listRefundsForOrders(ids);
  return { rows: ordered, extras, refunds, total, page, pageSize, pageCount };
}

export async function getOrderById(id: string) {
  const row = await prisma.order.findUnique({ where: { id }, include: ORDER_INCLUDE });
  if (!row) throw notFound('Order not found.');
  const refunds = await listRefundsForOrders([row.id]);
  return { row, extras: await loadLineExtras([row.id]), refunds: refunds.get(row.id) ?? [] };
}

async function loadOrderOr404(id: string) {
  const row = await prisma.order.findUnique({ where: { id } });
  if (!row) throw notFound('Order not found.');
  return row;
}

export async function advanceOrder(id: string, input: AdvanceOrderInput) {
  const order = await loadOrderOr404(id);

  if (!['paid', 'partially_refunded'].includes(order.paymentStatus)) {
    throw conflict('This order must be paid before its fulfilment can advance.');
  }
  const currentIndex = FULFILMENT_ORDER.indexOf(order.fulfilmentStatus as (typeof FULFILMENT_ORDER)[number]);
  const targetIndex = FULFILMENT_ORDER.indexOf(input.to as (typeof FULFILMENT_ORDER)[number]);
  if (currentIndex === -1 || targetIndex !== currentIndex + 1) {
    throw badRequest(`Cannot move from "${order.fulfilmentStatus}" to "${input.to}". Advance one step at a time.`, [{ path: 'to', message: 'Invalid transition.' }]);
  }

  const messages: Record<string, string> = {
    processing: 'processing: Order is being prepared.',
    shipped: `shipped: Shipped via ${input.carrier} (${input.trackingNumber}).`,
    delivered: 'delivered: Delivered.',
  };

  return prisma.$transaction(async (tx) => {
    // The return window is measured from delivery, never from order.updatedAt — so
    // every line is stamped when the order advances to 'delivered', in the same
    // transaction as the status change.
    if (input.to === 'delivered') {
      await tx.orderLine.updateMany({ where: { orderId: order.id }, data: { deliveredAt: new Date() } });
    }
    return tx.order.update({
      where: { id: order.id },
      data: {
        fulfilmentStatus: input.to,
        ...(input.to === 'shipped' ? { carrier: input.carrier, trackingNumber: input.trackingNumber, trackingUrl: input.trackingUrl || null } : {}),
        events: { create: [{ type: 'fulfilment', message: messages[input.to], actor: 'admin' }] },
      },
      include: ORDER_INCLUDE,
    });
  });
}

export async function updateOrderTracking(id: string, input: UpdateTrackingInput) {
  const order = await loadOrderOr404(id);
  if (!['shipped', 'delivered'].includes(order.fulfilmentStatus)) {
    throw conflict('Tracking can be edited after the order has shipped.');
  }
  return prisma.order.update({
    where: { id: order.id },
    data: {
      carrier: input.carrier,
      trackingNumber: input.trackingNumber,
      trackingUrl: input.trackingUrl || null,
      events: { create: [{ type: 'tracking', message: `Tracking updated: ${input.carrier} ${input.trackingNumber}.`, actor: 'admin' }] },
    },
    include: ORDER_INCLUDE,
  });
}

/**
 * L-I6: return every line of an order to stock, exactly once. Shared by cancelOrder
 * (restock at cancel time) and restockCancelledOrder (the later "Restock now" action
 * for an order cancelled without restock). Runs inside the caller's transaction;
 * returns the SKUs whose variant no longer exists, so the caller can say so on the
 * timeline instead of failing silently (M-I3). Uses atomic increments (M-I7) and
 * writes one `order_cancelled` history row per restocked line.
 */
async function restockOrderLines(
  tx: Prisma.TransactionClient,
  order: { id: string; number: string },
  actorEmail: string,
): Promise<string[]> {
  const lines = await tx.orderLine.findMany({ where: { orderId: order.id } });
  const skippedSkus: string[] = [];
  for (const line of lines) {
    const variant = await tx.productVariant.findUnique({ where: { id: line.variantId }, select: { stock: true, product: { select: { id: true, nameEn: true, nameHi: true } } } });
    if (!variant) { skippedSkus.push(line.sku); continue; } // the variant may have since been rebuilt by a product edit; nothing to restock against
    const updated = await tx.productVariant.updateMany({ where: { id: line.variantId }, data: { stock: { increment: line.quantity } } });
    if (updated.count === 0) { skippedSkus.push(line.sku); continue; }
    const afterRow = await tx.productVariant.findUnique({ where: { id: line.variantId }, select: { stock: true } });
    const after = afterRow?.stock ?? variant.stock + line.quantity;
    const before = after - line.quantity;
    await tx.inventoryAdjustment.create({
      data: {
        productId: variant.product.id,
        variantId: line.variantId,
        sku: line.sku,
        productNameEn: variant.product.nameEn,
        productNameHi: variant.product.nameHi,
        variantLabel: line.variantLabelEn,
        before,
        after,
        delta: line.quantity,
        reason: 'order_cancelled',
        note: `Restocked from cancelled order ${order.number}.`,
        actor: actorEmail,
      },
    });
  }
  return skippedSkus;
}

/**
 * Cancels an unshipped order; optionally restocks its lines (exactly once) and refunds
 * what was paid. The refund is REAL, not ledger-only: card/UPI orders are refunded
 * through Razorpay before the cancellation transaction runs (a gateway failure aborts
 * the cancel, so the order is never cancelled without its refund), wallet orders are
 * credited back to the wallet inside the transaction. Orders with no stored Razorpay
 * payment reference cannot be auto-refunded — cancel without a refund, then record a
 * manual refund from the order page.
 */
export async function cancelOrder(id: string, input: CancelOrderInput, actorEmail: string, deps?: RefundDeps) {
  const order = await loadOrderOr404(id);
  if (!['unfulfilled', 'processing'].includes(order.fulfilmentStatus)) {
    throw conflict('An order that has already shipped cannot be cancelled. Use a refund instead.');
  }

  const refundable = refundableOf(order);
  let gatewayRefund: { refundId: string; gateway: GatewayRefund } | null = null;
  let walletRefund = false;
  if (input.refund && refundable > 0) {
    if (order.paymentMethod === 'wallet') {
      if (!order.customerId) {
        throw conflict('This wallet-paid order has no customer account, so the refund cannot be credited. Cancel without a refund, then handle it manually.');
      }
      walletRefund = true;
    } else {
      gatewayRefund = await runGatewayRefund(
        { orderId: order.id, orderNumber: order.number, returnId: null, amount: refundable, reason: `Cancellation: ${input.reason || 'No reason given'}`, actorEmail },
        order,
        deps,
      );
    }
  }

  return prisma.$transaction(async (tx) => {
    // H6: the guards are re-checked INSIDE the transaction, not just before it —
    // the pre-transaction load above is only a fast path. A concurrent cancel (or
    // a refund that landed between the load and this transaction) must not restock
    // twice or refund against stale totals.
    const fresh = await tx.order.findUnique({ where: { id: order.id } });
    if (!fresh) throw notFound('Order not found.');
    if (!['unfulfilled', 'processing'].includes(fresh.fulfilmentStatus)) {
      throw conflict('An order that has already shipped cannot be cancelled. Use a refund instead.');
    }
    const freshRefundable = refundableOf(fresh);

    const events: Array<{ type: string; message: string; actor: 'admin' }> = [
      { type: 'cancelled', message: `Cancelled: ${input.reason || 'No reason given'}.`, actor: 'admin' },
    ];

    if (input.restock && !fresh.restocked) {
      // M-I3: a missing variant no longer fails silently — skipped SKUs are recorded
      // on the order timeline so the owner can see units that were never returned.
      const skippedSkus = await restockOrderLines(tx, order, actorEmail);
      if (skippedSkus.length) {
        events.push({ type: 'restock_skipped', message: `Could not restock ${skippedSkus.length} line(s) — the variant no longer exists, so those units were not returned to stock: ${skippedSkus.join(', ')}.`, actor: 'admin' });
      }
    }

    let refundedTotal = fresh.refundedTotal;
    let paymentStatus = fresh.paymentStatus;
    if (input.refund && refundable > 0) {
      if (gatewayRefund) {
        // The gateway refund was already issued for the pre-transaction refundable
        // amount. If a concurrent refund changed the order since, the amounts no
        // longer agree — abort rather than writing totals that contradict the
        // gateway refund. The refund row stays traceable for the owner to review.
        if (freshRefundable !== refundable) {
          throw conflict('The order changed while the refund was being processed. The Razorpay refund is recorded on the order — review it before retrying.');
        }
        const state = await completeRefundRow(tx, gatewayRefund.refundId, gatewayRefund.gateway);
        if (state === 'completed') {
          refundedTotal = fresh.refundedTotal + refundable;
          paymentStatus = 'refunded';
          events.push({ type: 'refund', message: `Refunded ${refundable} ${order.currency} via Razorpay (refund ${gatewayRefund.gateway.id}, cancellation).`, actor: 'admin' });
        } else {
          events.push({ type: 'refund', message: `Razorpay refund ${gatewayRefund.gateway.id} is processing (${refundable} ${order.currency}). Totals will update once it settles.`, actor: 'admin' });
        }
      } else if (walletRefund) {
        // Wallet refunds are issued inside this transaction, so they use the fresh
        // refundable amount — a concurrent refund simply shrinks what is credited.
        if (freshRefundable <= 0) throw conflict('The order was already refunded by another action.');
        const refundId = randomHexId(12);
        const walletRef = `refund:order:${refundId}`;
        await insertRefundRow(tx, {
          id: refundId,
          orderId: order.id,
          returnId: null,
          amount: freshRefundable,
          reason: `Cancellation: ${input.reason || 'No reason given'}`,
          method: 'store_credit',
          status: 'completed',
          reference: walletRef,
          recordedBy: actorEmail,
          note: null,
        });
        await creditWallet(order.customerId!, freshRefundable, 'refund', walletRef, { orderId: order.id, tx });
        refundedTotal = fresh.refundedTotal + freshRefundable;
        paymentStatus = 'refunded';
        events.push({ type: 'refund', message: `Refunded ${freshRefundable} ${order.currency} to the customer wallet (cancellation).`, actor: 'admin' });
      }
    }

    return tx.order.update({
      where: { id: order.id },
      data: { fulfilmentStatus: 'cancelled', restocked: input.restock || fresh.restocked, refundedTotal, paymentStatus, events: { create: events } },
      include: ORDER_INCLUDE,
    });
  });
}

/**
 * L-I6: "Restock now" for an order cancelled WITHOUT restock. Cancelling with the
 * restock box unchecked used to be a one-shot, irreversible choice — the units were
 * never returned and no later action existed. This replays the same exactly-once
 * restock (same helper as cancelOrder), guarded by `order.restocked`.
 */
export async function restockCancelledOrder(id: string, actorEmail: string) {
  const order = await loadOrderOr404(id);
  if (order.fulfilmentStatus !== 'cancelled') {
    throw conflict('Only a cancelled order can be restocked.');
  }
  if (order.restocked) {
    throw conflict('This order was already restocked.');
  }
  const updated = await prisma.$transaction(async (tx) => {
    const skippedSkus = await restockOrderLines(tx, order, actorEmail);
    const events: Array<{ type: string; message: string; actor: 'admin' }> = [
      { type: 'restock', message: 'Items returned to stock after cancellation.', actor: 'admin' },
    ];
    if (skippedSkus.length) {
      events.push({ type: 'restock_skipped', message: `Could not restock ${skippedSkus.length} line(s) — the variant no longer exists, so those units were not returned to stock: ${skippedSkus.join(', ')}.`, actor: 'admin' });
    }
    return tx.order.update({
      where: { id: order.id },
      data: { restocked: true, events: { create: events } },
      include: ORDER_INCLUDE,
    });
  });
  return updated;
}

/** Direct order refund — delegates to the shared refund service (real Razorpay/manual/wallet). */
export async function refundOrder(id: string, input: RefundOrderInput, actorEmail: string, deps?: RefundDeps) {
  const order = await loadOrderOr404(id);
  await issueOrderRefund(order, { amount: input.amount, reason: input.reason, method: input.method, reference: input.reference, note: input.note }, actorEmail, deps);
  const fresh = await getOrderById(id);
  return fresh.row;
}

export interface MarkOrderPaidInput {
  /** Razorpay payment id (or other gateway reference) proving the payment. */
  paymentReference?: string | null;
  /** Audit note for the manual reconciliation. Mandatory when no reference is given. */
  note?: string;
  /** Explicit override: mark paid with no payment reference at all. Requires `note`. */
  force?: boolean;
}

/**
 * M5: marking an order paid requires proof — a non-empty payment reference, or an
 * explicit `force` with a mandatory audit note. The order event (and the note, when
 * given) records that this was a manual reconciliation and with what reference, so
 * a paid order can never again appear with zero evidence behind it.
 */
export async function markOrderPaid(id: string, input: MarkOrderPaidInput = {}, actorEmail = 'admin') {
  const order = await loadOrderOr404(id);
  if (order.paymentStatus !== 'unpaid' || order.fulfilmentStatus === 'cancelled') {
    throw conflict('Only an unpaid, non-cancelled order can be marked paid.');
  }
  const reference = input.paymentReference?.trim() || null;
  if (!reference && !input.force) {
    throw badRequest('A payment reference is required to mark an order paid. If the payment cannot be traced to a reference, use the manual reconciliation override and include an audit note.', [{ path: 'paymentReference', message: 'Payment reference required.' }]);
  }
  if (!reference && !input.note?.trim()) {
    throw badRequest('A manual reconciliation without a payment reference requires an audit note explaining how the payment was verified.', [{ path: 'note', message: 'Audit note required.' }]);
  }
  const message = reference
    ? `Marked as paid (manual reconciliation, payment reference ${reference}).${input.note ? ` ${input.note}` : ''}`
    : `Marked as paid (manual reconciliation without a payment reference). Note: ${input.note}`;
  return prisma.order.update({
    where: { id: order.id },
    data: {
      paymentStatus: 'paid',
      ...(reference ? { paymentReference: reference } : {}),
      events: { create: [{ type: 'payment', message, actor: 'admin' }] },
      ...(input.note?.trim()
        ? { notes: { create: [{ author: actorEmail, body: `Manual reconciliation: ${input.note.trim()}${reference ? ` (payment reference ${reference})` : ''}` }] } }
        : {}),
    },
    include: ORDER_INCLUDE,
  });
}

export async function addOrderNote(id: string, input: AddNoteInput, authorEmail: string) {
  const order = await loadOrderOr404(id);
  return prisma.order.update({
    where: { id: order.id },
    data: { notes: { create: [{ author: authorEmail, body: input.body }] } },
    include: ORDER_INCLUDE,
  });
}
