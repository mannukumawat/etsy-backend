import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { requireOwner } from '../auth.js';
import { prisma } from '../db.js';
import { badRequest, conflict, notFound, route } from '../http.js';
import {
  toAdminExchange,
  type ExchangeRequestRow,
  type ExchangeEventRow,
} from '../mappers.js';
import {
  approveExchangeSchema,
  rejectExchangeSchema,
  shipExchangeSchema,
} from '../validation.js';

function newId() { return randomBytes(12).toString('hex'); }

async function fetchExchangeFull(id: string) {
  const [rows, events] = await Promise.all([
    prisma.$queryRawUnsafe<ExchangeRequestRow[]>(`SELECT * FROM exchange_requests WHERE id = ?`, id),
    prisma.$queryRawUnsafe<ExchangeEventRow[]>(
      `SELECT * FROM exchange_events WHERE exchange_id = ? ORDER BY created_at ASC`, id,
    ),
  ]);
  return { row: rows[0] ?? null, events };
}

async function loadExchangeOr404(id: string) {
  const rows = await prisma.$queryRawUnsafe<ExchangeRequestRow[]>(
    `SELECT * FROM exchange_requests WHERE id = ?`, id,
  );
  if (!rows[0]) throw notFound('Exchange request not found.');
  return rows[0];
}

function assertExchangeStatus(row: ExchangeRequestRow, expected: string) {
  if (row.status !== expected) {
    throw conflict(`Expected status '${expected}', got '${row.status}'.`);
  }
}

async function addEvent(exchangeId: string, type: string, actor: string, message: string, actorId?: string) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO exchange_events (id, exchange_id, type, actor, actor_id, message, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NOW(3))`,
    newId(), exchangeId, type, actor, actorId ?? null, message,
  );
}

export const adminExchangesRouter = Router();
adminExchangesRouter.use(requireOwner);

// GET / — list all exchanges
adminExchangesRouter.get(
  '/',
  route(async (req, res) => {
    const status = req.query.status as string | undefined;
    let sql = `SELECT er.* FROM exchange_requests er ORDER BY er.requested_at DESC LIMIT 200`;
    const params: unknown[] = [];
    if (status) {
      sql = `SELECT er.* FROM exchange_requests er WHERE er.status = ? ORDER BY er.requested_at DESC LIMIT 200`;
      params.push(status);
    }
    const rows = await prisma.$queryRawUnsafe<ExchangeRequestRow[]>(sql, ...params);
    res.json({ items: rows.map(r => toAdminExchange(r)) });
  }),
);

// GET /:id — detail
adminExchangesRouter.get(
  '/:id',
  route(async (req, res) => {
    const row = await loadExchangeOr404(req.params.id);
    const { events } = await fetchExchangeFull(row.id);
    res.json(toAdminExchange(row, events));
  }),
);

// PATCH /:id/approve
adminExchangesRouter.patch(
  '/:id/approve',
  route(async (req, res) => {
    const input = approveExchangeSchema.parse(req.body);
    const row = await loadExchangeOr404(req.params.id);
    assertExchangeStatus(row, 'requested');

    // Check replacement stock
    const variant = await prisma.productVariant.findUnique({
      where: { id: row.replacement_variant_id },
      select: { stock: true },
    });
    if (!variant || variant.stock < input.approvedQty) {
      throw conflict('Insufficient replacement stock to approve this exchange.');
    }

    await prisma.$executeRawUnsafe(
      `UPDATE exchange_requests SET status = 'approved', approved_qty = ?, decided_at = NOW(3) WHERE id = ?`,
      input.approvedQty, row.id,
    );
    await addEvent(row.id, 'approved', 'admin', `Approved for ${input.approvedQty} unit(s).${input.note ? ' ' + input.note : ''}`, req.owner!.sub);

    const { row: updated, events } = await fetchExchangeFull(row.id);
    res.json(toAdminExchange(updated!, events));
  }),
);

// PATCH /:id/reject
adminExchangesRouter.patch(
  '/:id/reject',
  route(async (req, res) => {
    const input = rejectExchangeSchema.parse(req.body);
    const row = await loadExchangeOr404(req.params.id);
    if (!['requested', 'approved'].includes(row.status)) {
      throw conflict(`Cannot reject from status '${row.status}'.`);
    }

    // Release reserved qty
    await prisma.$executeRawUnsafe(
      `UPDATE order_lines SET exchanged_qty = GREATEST(0, COALESCE(exchanged_qty, 0) - ?) WHERE id = ?`,
      row.requested_qty, row.order_line_id,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE exchange_requests SET status = 'rejected', rejection_reason = ?, decided_at = NOW(3) WHERE id = ?`,
      input.reason, row.id,
    );
    await addEvent(row.id, 'rejected', 'admin', `Rejected: ${input.reason}`, req.owner!.sub);

    const { row: updated, events } = await fetchExchangeFull(row.id);
    res.json(toAdminExchange(updated!, events));
  }),
);

// PATCH /:id/ship — record replacement shipment
adminExchangesRouter.patch(
  '/:id/ship',
  route(async (req, res) => {
    const input = shipExchangeSchema.parse(req.body);
    const row = await loadExchangeOr404(req.params.id);
    assertExchangeStatus(row, 'approved');

    // Deduct stock for replacement variant
    const variant = await prisma.productVariant.findUnique({
      where: { id: row.replacement_variant_id },
      select: { stock: true, sku: true, product: { select: { id: true, nameEn: true, nameHi: true } } },
    });
    if (variant) {
      const before = variant.stock;
      const after = Math.max(0, before - (row.approved_qty ?? row.requested_qty));
      await prisma.productVariant.update({
        where: { id: row.replacement_variant_id },
        data: { stock: after },
      });
      await prisma.inventoryAdjustment.create({
        data: {
          productId: variant.product.id,
          variantId: row.replacement_variant_id,
          sku: variant.sku,
          productNameEn: variant.product.nameEn,
          productNameHi: variant.product.nameHi,
          variantLabel: '',
          before,
          after,
          delta: -(row.approved_qty ?? row.requested_qty),
          reason: 'exchange_shipped',
          note: `Exchange ${row.reference} replacement shipped.`,
          actor: req.owner!.email,
        },
      });
    }

    await prisma.$executeRawUnsafe(
      `UPDATE exchange_requests SET status = 'shipped', replacement_carrier = ?, replacement_tracking = ?, shipped_at = NOW(3) WHERE id = ?`,
      input.carrier, input.tracking, row.id,
    );
    await addEvent(row.id, 'shipped', 'admin', `Replacement shipped via ${input.carrier} (${input.tracking}).`, req.owner!.sub);

    const { row: updated, events } = await fetchExchangeFull(row.id);
    res.json(toAdminExchange(updated!, events));
  }),
);

// PATCH /:id/deliver — mark replacement delivered
adminExchangesRouter.patch(
  '/:id/deliver',
  route(async (req, res) => {
    const row = await loadExchangeOr404(req.params.id);
    assertExchangeStatus(row, 'shipped');

    await prisma.$executeRawUnsafe(
      `UPDATE exchange_requests SET status = 'delivered', delivered_at = NOW(3) WHERE id = ?`,
      row.id,
    );
    await addEvent(row.id, 'delivered', 'admin', 'Replacement delivered to customer.', req.owner!.sub);

    const { row: updated, events } = await fetchExchangeFull(row.id);
    res.json(toAdminExchange(updated!, events));
  }),
);

// PATCH /:id/close
adminExchangesRouter.patch(
  '/:id/close',
  route(async (req, res) => {
    const row = await loadExchangeOr404(req.params.id);
    if (!['delivered', 'approved'].includes(row.status)) {
      throw conflict(`Cannot close from status '${row.status}'.`);
    }

    await prisma.$executeRawUnsafe(
      `UPDATE exchange_requests SET status = 'closed', closed_at = NOW(3) WHERE id = ?`,
      row.id,
    );
    await addEvent(row.id, 'closed', 'admin', 'Exchange request closed.', req.owner!.sub);

    const { row: updated, events } = await fetchExchangeFull(row.id);
    res.json(toAdminExchange(updated!, events));
  }),
);
