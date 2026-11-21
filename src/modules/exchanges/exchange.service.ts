import { prisma } from '../../shared/database/prisma.js';
import { badRequest, conflict, notFound } from '../../shared/errors/http-error.js';
import { randomHexId } from '../../shared/utils/ids.js';
import { convertFromBase, type CurrencyConfigLike } from '../../shared/utils/currency.js';
import { fetchExchangeWithEvents, toExchangeRequestRow } from './exchange.repository.js';
import { assertWithinDeliveryWindow, findDeliveredEventAt, resolveDeliveryWindow } from '../returns/return.service.js';
import type { CreateExchangeInput } from './exchange.schema.js';

// Customer-side exchange workflow, backed by the Prisma ExchangeRequest /
// ExchangeEvent models. The create / withdraw sequences run inside a transaction,
// so a mid-sequence failure can never leave a reserved quantity without a request,
// or vice versa (H15).

function generateExchangeRef() { return 'EXC-' + randomHexId(4).toUpperCase(); }

// --- Price difference (H16) -------------------------------------------------
//
// The replacement variant's price is stored in USD-base minor units, while the
// order line's unitPrice is the price already converted into the order's
// currency. Comparing them directly mixes currencies (wrong for every non-USD
// order). The difference is therefore computed from CONVERTED prices on both
// sides, using the rate frozen on the order itself — never a live rate — so the
// difference can never drift after checkout. The amount is in the order
// currency's minor units; a refund of it is never converted again.

/** The stored rate snapshot, in either shape it has been written in. */
export interface ParsedRateSnapshot {
  rates?: Record<string, number>;
  currency?: string;
  rate?: number;
}

/**
 * Parses the order's rateSnapshotJson. Orders are written with the full map
 * `{base: 'USD', rates: {...}, asOf}` (buildRateSnapshot); older rows may carry
 * the single-rate shape `{base, currency, rate, capturedAt}` — both are accepted.
 */
export function parseRateSnapshot(rateSnapshotJson: string): ParsedRateSnapshot {
  try {
    const parsed: unknown = JSON.parse(rateSnapshotJson);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as ParsedRateSnapshot;
  } catch {
    return {};
  }
}

/** The frozen rate for the order's currency. Throws when the snapshot has no usable rate — a price difference must never be computed from a guessed rate. */
export function rateForOrderCurrency(rateSnapshotJson: string, currency: string): number {
  const snapshot = parseRateSnapshot(rateSnapshotJson);
  const rate = snapshot.rates?.[currency] ?? (snapshot.currency === currency ? snapshot.rate : undefined);
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
    throw new Error(`No usable exchange rate for ${currency} on this order. Cannot price the exchange.`);
  }
  return rate;
}

/**
 * Converts a USD-base minor-unit price into the order currency's minor units,
 * with the order's frozen rate and the currency's own rounding rules. Reuses the
 * single shared converter (convertFromBase) — no second converter exists.
 */
export function convertedReplacementPrice(
  baseMinor: number,
  currency: string,
  rateSnapshotJson: string,
  currencyConfig: Pick<CurrencyConfigLike, 'fractionDigits' | 'roundingIncrement'>,
): number {
  const rate = rateForOrderCurrency(rateSnapshotJson, currency);
  return convertFromBase(baseMinor, {
    code: currency,
    rate,
    fractionDigits: currencyConfig.fractionDigits,
    roundingIncrement: currencyConfig.roundingIncrement,
  });
}

/**
 * Price difference for an exchange, in the order currency's minor units.
 * Positive = the customer owes the difference; negative = the customer overpaid
 * and is refunded the difference when the exchange ships.
 */
export function computePriceDifference(input: {
  replacementBaseMinor: number;
  lineUnitPrice: number;
  qty: number;
  currency: string;
  rateSnapshotJson: string;
  currencyConfig: Pick<CurrencyConfigLike, 'fractionDigits' | 'roundingIncrement'>;
}): number {
  const replacementConverted = convertedReplacementPrice(
    input.replacementBaseMinor,
    input.currency,
    input.rateSnapshotJson,
    input.currencyConfig,
  );
  return (replacementConverted - input.lineUnitPrice) * input.qty;
}

/** Shared quantity guard: the requested units must fit in what is still eligible and not already covered by a pending exchange. */
export function assertExchangeableQty(input: {
  quantity: number;
  cancelledQty: number;
  returnedQty: number;
  exchangedQty: number;
  pendingQty: number;
  qty: number;
}): void {
  const eligibleQty = input.quantity - input.cancelledQty - input.returnedQty - input.exchangedQty;
  if (input.qty > eligibleQty) {
    throw badRequest(`Cannot exchange ${input.qty} — only ${eligibleQty} eligible units remain.`);
  }
  if (input.pendingQty + input.qty > eligibleQty) {
    throw conflict(`Only ${eligibleQty - input.pendingQty} units are not already covered by a pending exchange.`);
  }
}

async function loadExchangeForCustomer(ref: string, customerId: string) {
  const row = await prisma.exchangeRequest.findUnique({ where: { reference: ref } });
  if (!row) throw notFound('Exchange request not found.');
  const order = await prisma.order.findFirst({
    where: { id: row.orderId, customerId, customerKind: 'account' },
    select: { id: true },
  });
  if (!order) throw notFound('Exchange request not found.');
  return toExchangeRequestRow(row);
}

/** Creates an exchange request for a delivered order line and reserves the exchanged quantity. */
export async function requestExchange(customerId: string, input: CreateExchangeInput) {
  const order = await prisma.order.findFirst({
    where: { id: input.orderId, customerId, customerKind: 'account' },
  });
  if (!order) throw notFound('Order not found.');
  if (order.fulfilmentStatus !== 'delivered') {
    throw conflict('Exchanges can only be requested after the order has been delivered.');
  }

  // Load original line
  const line = await prisma.orderLine.findUnique({ where: { id: input.lineId } });
  if (!line || line.orderId !== input.orderId) throw notFound('Order line not found.');

  // Exchange window: line override, else the product's returnDays, else the 7-day
  // default — measured from the line's deliveredAt, falling back to the order's
  // delivered event. Never order.updatedAt (M4).
  const product = await prisma.product.findUnique({
    where: { id: line.productId },
    select: { exchangeAllowed: true, returnDays: true },
  });
  if (product && !product.exchangeAllowed) {
    throw conflict('This product is not eligible for exchanges.');
  }
  const deliveredEventAt = line.deliveredAt ? null : await findDeliveredEventAt(input.orderId);
  const window = resolveDeliveryWindow({
    deliveredAt: line.deliveredAt,
    deliveredEventAt,
    lineWindowDays: line.returnWindowDays,
    productReturnDays: product?.returnDays ?? null,
  });
  assertWithinDeliveryWindow(window, 'exchange');

  // Quantity check (early, customer-facing); re-validated inside the transaction below.
  const activeExchanges = await prisma.exchangeRequest.findMany({
    where: { orderLineId: input.lineId, status: { notIn: ['rejected', 'withdrawn', 'closed'] } },
    select: { requestedQty: true },
  });
  const pendingQty = activeExchanges.reduce((s: number, r: { requestedQty: number }) => s + r.requestedQty, 0);
  assertExchangeableQty({
    quantity: line.quantity,
    cancelledQty: line.cancelledQty,
    returnedQty: line.returnedQty,
    exchangedQty: line.exchangedQty,
    pendingQty,
    qty: input.qty,
  });

  // Load replacement variant to compute price difference
  const replacementVariant = await prisma.productVariant.findUnique({
    where: { id: input.replacementVariantId },
    select: { price: true, salePrice: true, stock: true, productId: true },
  });
  if (!replacementVariant) throw notFound('Replacement variant not found.');
  if (replacementVariant.productId !== line.productId) {
    throw badRequest('Replacement variant must be from the same product.');
  }
  if (replacementVariant.stock < input.qty) {
    throw conflict(`Insufficient stock for the selected replacement (${replacementVariant.stock} available).`);
  }

  // Price difference from CONVERTED prices (H16): the replacement's USD-base price
  // converted with the order's frozen rate, against the line's converted unit price.
  // The currency's rounding rules come from its config; the rate always comes from
  // the order snapshot, never the live config.
  const currencyConfig = await prisma.currencyConfig.findFirst({
    where: { settingsId: 'singleton', code: order.currency },
    select: { fractionDigits: true, roundingIncrement: true },
  });
  const priceDifference = computePriceDifference({
    replacementBaseMinor: replacementVariant.salePrice ?? replacementVariant.price,
    lineUnitPrice: line.unitPrice,
    qty: input.qty,
    currency: order.currency,
    rateSnapshotJson: order.rateSnapshotJson,
    currencyConfig: currencyConfig ?? { fractionDigits: 2, roundingIncrement: 1 },
  });

  const id = randomHexId(12);
  const reference = generateExchangeRef();

  // One transaction: the request, the quantity reservation, the timeline event and
  // the order event land together, with the quantity guard re-checked against the
  // freshly read line so concurrent requests cannot over-reserve.
  await prisma.$transaction(async (tx: any) => {
    const freshLine = await tx.orderLine.findUnique({ where: { id: input.lineId } });
    if (!freshLine) throw notFound('Order line not found.');
    const freshPending = await tx.exchangeRequest.findMany({
      where: { orderLineId: input.lineId, status: { notIn: ['rejected', 'withdrawn', 'closed'] } },
      select: { requestedQty: true },
    });
    assertExchangeableQty({
      quantity: freshLine.quantity,
      cancelledQty: freshLine.cancelledQty,
      returnedQty: freshLine.returnedQty,
      exchangedQty: freshLine.exchangedQty,
      pendingQty: freshPending.reduce((s: number, r: { requestedQty: number }) => s + r.requestedQty, 0),
      qty: input.qty,
    });

    await tx.exchangeRequest.create({
      data: {
        id,
        reference,
        orderId: input.orderId,
        orderLineId: input.lineId,
        originalVariantId: line.variantId,
        replacementVariantId: input.replacementVariantId,
        requestedQty: input.qty,
        reason: input.reason,
        customerNote: input.note ?? null,
        status: 'requested',
        priceDifference,
        exchangeWindowDays: window.windowDays,
      },
    });

    // Reserve exchanged qty
    await tx.orderLine.update({
      where: { id: input.lineId },
      data: { exchangedQty: { increment: input.qty } },
    });

    await tx.exchangeEvent.create({
      data: {
        id: randomHexId(12),
        exchangeId: id,
        type: 'requested',
        actor: 'customer',
        actorId: customerId,
        message: `Exchange requested: ${input.qty} unit(s). Reason: ${input.reason}`,
      },
    });

    await tx.orderEvent.create({
      data: {
        orderId: input.orderId,
        type: 'return',
        message: `Exchange request ${reference} submitted for ${input.qty} unit(s) of ${line.nameEn}.`,
        actor: 'customer',
      },
    });
  });

  return fetchExchangeWithEvents(id);
}

export async function listCustomerExchanges(customerId: string) {
  const orders = await prisma.order.findMany({
    where: { customerId, customerKind: 'account' },
    select: { id: true },
  });
  if (orders.length === 0) return [];
  const rows = await prisma.exchangeRequest.findMany({
    where: { orderId: { in: orders.map((o: { id: string }) => o.id) } },
    orderBy: { requestedAt: 'desc' },
  });
  return rows.map(toExchangeRequestRow);
}

export async function getCustomerExchange(customerId: string, reference: string) {
  const row = await loadExchangeForCustomer(reference, customerId);
  const { events } = await fetchExchangeWithEvents(row.id);
  return { row, events };
}

/** Withdraws a still-unreviewed request and releases the reserved quantity. Returns the reference. */
export async function withdrawExchange(customerId: string, reference: string) {
  const row = await loadExchangeForCustomer(reference, customerId);
  if (row.status !== 'requested') {
    throw conflict('This exchange request can no longer be withdrawn — it has already been reviewed.');
  }

  await prisma.$transaction(async (tx: any) => {
    await tx.exchangeRequest.update({
      where: { id: row.id },
      data: { status: 'withdrawn', decidedAt: new Date() },
    });
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
    await tx.exchangeEvent.create({
      data: {
        id: randomHexId(12),
        exchangeId: row.id,
        type: 'withdrawn',
        actor: 'customer',
        actorId: customerId,
        message: 'Customer withdrew the exchange request.',
      },
    });
  });

  return row.reference;
}
