import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { requireCustomer } from '../customerAuth.js';
import { prisma } from '../db.js';
import { badRequest, conflict, notFound, route } from '../http.js';
import {
  toPublicExchange,
  type ExchangeRequestRow,
  type ExchangeEventRow,
} from '../mappers.js';
import { createExchangeSchema } from '../validation.js';

function newId() { return randomBytes(12).toString('hex'); }
function generateExchangeRef() { return 'EXC-' + randomBytes(4).toString('hex').toUpperCase(); }

async function fetchExchangeRows(exchangeId: string) {
  const [rows, events] = await Promise.all([
    prisma.$queryRawUnsafe<ExchangeRequestRow[]>(`SELECT * FROM exchange_requests WHERE id = ?`, exchangeId),
    prisma.$queryRawUnsafe<ExchangeEventRow[]>(
      `SELECT * FROM exchange_events WHERE exchange_id = ? ORDER BY created_at ASC`, exchangeId,
    ),
  ]);
  return { row: rows[0] ?? null, events };
}

async function loadExchangeForCustomer(ref: string, customerId: string) {
  const rows = await prisma.$queryRawUnsafe<ExchangeRequestRow[]>(
    `SELECT er.* FROM exchange_requests er
     JOIN orders o ON o.id = er.order_id
     WHERE er.reference = ? AND o.customerId = ? AND o.customerKind = 'account'`,
    ref, customerId,
  );
  if (!rows[0]) throw notFound('Exchange request not found.');
  return rows[0];
}

async function addExchangeEvent(exchangeId: string, type: string, actor: string, message: string, actorId?: string) {
  const id = newId();
  await prisma.$executeRawUnsafe(
    `INSERT INTO exchange_events (id, exchange_id, type, actor, actor_id, message, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NOW(3))`,
    id, exchangeId, type, actor, actorId ?? null, message,
  );
}

export const customerExchangesRouter = Router();
customerExchangesRouter.use(requireCustomer);

// POST / — create exchange request
customerExchangesRouter.post(
  '/',
  route(async (req, res) => {
    const input = createExchangeSchema.parse(req.body);
    const customerId = req.customer!.sub;

    const order = await prisma.order.findFirst({
      where: { id: input.orderId, customerId, customerKind: 'account' },
    });
    if (!order) throw notFound('Order not found.');
    if (order.fulfilmentStatus !== 'delivered') {
      throw conflict('Exchanges can only be requested after the order has been delivered.');
    }

    // Load original line
    const lines = await prisma.$queryRawUnsafe<Array<{
      id: string; variant_id: string; quantity: number; cancelled_qty: number;
      returned_qty: number; exchanged_qty: number; delivered_at: Date | null;
      return_window_days: number | null; unit_price: number; name_en: string; product_id: string;
    }>>(
      `SELECT id, variantId AS variant_id, quantity, cancelled_qty, returned_qty,
              COALESCE(exchanged_qty, 0) AS exchanged_qty,
              delivered_at, return_window_days,
              unitPrice AS unit_price, nameEn AS name_en, productId AS product_id
       FROM order_lines WHERE id = ? AND orderId = ?`,
      input.lineId, input.orderId,
    );
    const line = lines[0];
    if (!line) throw notFound('Order line not found.');

    const eligibleQty = line.quantity - (line.cancelled_qty ?? 0) - (line.returned_qty ?? 0) - (line.exchanged_qty ?? 0);
    if (input.qty > eligibleQty) {
      throw badRequest(`Cannot exchange ${input.qty} — only ${eligibleQty} eligible units remain.`);
    }

    // Check pending exchanges on same line
    const activeExchanges = await prisma.$queryRawUnsafe<Array<{ requested_qty: number }>>(
      `SELECT requested_qty FROM exchange_requests
       WHERE order_line_id = ? AND status NOT IN ('rejected','withdrawn','closed')`,
      input.lineId,
    );
    const pendingQty = activeExchanges.reduce((s, r) => s + r.requested_qty, 0);
    if (pendingQty + input.qty > eligibleQty) {
      throw conflict(`Only ${eligibleQty - pendingQty} units are not already covered by a pending exchange.`);
    }

    // Exchange window
    const windowDays = line.return_window_days ?? 7;
    const deliveredAt = line.delivered_at ?? order.updatedAt;
    const deadlineMs = new Date(deliveredAt).getTime() + windowDays * 24 * 60 * 60 * 1000;
    if (Date.now() > deadlineMs) {
      throw conflict(`The ${windowDays}-day exchange window for this item has closed.`);
    }

    // Check product exchangeAllowed
    const product = await prisma.$queryRawUnsafe<Array<{ exchange_allowed: number }>>(
      `SELECT COALESCE(exchangeAllowed, 1) AS exchange_allowed FROM products WHERE id = ?`,
      line.product_id,
    );
    if (product[0] && product[0].exchange_allowed === 0) {
      throw conflict('This product is not eligible for exchanges.');
    }

    // Load replacement variant to compute price difference
    const replacementVariant = await prisma.productVariant.findUnique({
      where: { id: input.replacementVariantId },
      select: { price: true, salePrice: true, stock: true, productId: true },
    });
    if (!replacementVariant) throw notFound('Replacement variant not found.');
    if (replacementVariant.productId !== line.product_id) {
      throw badRequest('Replacement variant must be from the same product.');
    }
    if (replacementVariant.stock < input.qty) {
      throw conflict(`Insufficient stock for the selected replacement (${replacementVariant.stock} available).`);
    }

    const replacementPrice = replacementVariant.salePrice ?? replacementVariant.price;
    const priceDifference = (replacementPrice - line.unit_price) * input.qty;

    const id = newId();
    const reference = generateExchangeRef();

    await prisma.$executeRawUnsafe(
      `INSERT INTO exchange_requests
       (id, reference, order_id, order_line_id, original_variant_id, replacement_variant_id,
        requested_qty, reason, customer_note, status, price_difference, exchange_window_days, requested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?, NOW(3))`,
      id, reference, input.orderId, input.lineId, line.variant_id, input.replacementVariantId,
      input.qty, input.reason, input.note ?? null, priceDifference, windowDays,
    );

    // Reserve exchanged qty
    await prisma.$executeRawUnsafe(
      `UPDATE order_lines SET exchanged_qty = COALESCE(exchanged_qty, 0) + ? WHERE id = ?`,
      input.qty, input.lineId,
    );

    await addExchangeEvent(id, 'requested', 'customer', `Exchange requested: ${input.qty} unit(s). Reason: ${input.reason}`, customerId);

    await prisma.orderEvent.create({
      data: {
        orderId: input.orderId,
        type: 'return',
        message: `Exchange request ${reference} submitted for ${input.qty} unit(s) of ${line.name_en}.`,
        actor: 'customer',
      },
    });

    const { row, events } = await fetchExchangeRows(id);
    res.status(201).json(toPublicExchange(row!, events));
  }),
);

// GET / — list customer's exchanges
customerExchangesRouter.get(
  '/',
  route(async (req, res) => {
    const customerId = req.customer!.sub;
    const rows = await prisma.$queryRawUnsafe<ExchangeRequestRow[]>(
      `SELECT er.* FROM exchange_requests er
       JOIN orders o ON o.id = er.order_id
       WHERE o.customerId = ? AND o.customerKind = 'account'
       ORDER BY er.requested_at DESC`,
      customerId,
    );
    res.json({ items: rows.map(r => toPublicExchange(r)) });
  }),
);

// GET /:ref — get by reference
customerExchangesRouter.get(
  '/:ref',
  route(async (req, res) => {
    const customerId = req.customer!.sub;
    const row = await loadExchangeForCustomer(req.params.ref, customerId);
    const { events } = await fetchExchangeRows(row.id);
    res.json(toPublicExchange(row, events));
  }),
);

// DELETE /:ref — withdraw
customerExchangesRouter.delete(
  '/:ref',
  route(async (req, res) => {
    const customerId = req.customer!.sub;
    const row = await loadExchangeForCustomer(req.params.ref, customerId);
    if (row.status !== 'requested') {
      throw conflict('This exchange request can no longer be withdrawn — it has already been reviewed.');
    }

    await prisma.$executeRawUnsafe(
      `UPDATE exchange_requests SET status = 'withdrawn', decided_at = NOW(3) WHERE id = ?`,
      row.id,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE order_lines SET exchanged_qty = GREATEST(0, COALESCE(exchanged_qty, 0) - ?) WHERE id = ?`,
      row.requested_qty, row.order_line_id,
    );
    await addExchangeEvent(row.id, 'withdrawn', 'customer', 'Customer withdrew the exchange request.', customerId);

    res.json({ ok: true, reference: row.reference });
  }),
);
