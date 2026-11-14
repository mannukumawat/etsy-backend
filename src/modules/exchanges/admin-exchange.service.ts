import { prisma } from '../../shared/database/prisma.js';
import { conflict, notFound } from '../../shared/errors/http-error.js';
import { addExchangeEvent, fetchExchangeWithEvents } from './exchange.repository.js';
import type { ApproveExchangeInput, RejectExchangeInput, ShipExchangeInput } from './exchange.schema.js';
import type { ExchangeRequestRow, OwnerActor } from './exchange.types.js';

// Owner-side exchange workflow: requested -> approved -> shipped -> delivered -> closed (or rejected).

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

export async function listExchanges(status: string | undefined) {
  let sql = `SELECT er.* FROM exchange_requests er ORDER BY er.requested_at DESC LIMIT 200`;
  const params: unknown[] = [];
  if (status) {
    sql = `SELECT er.* FROM exchange_requests er WHERE er.status = ? ORDER BY er.requested_at DESC LIMIT 200`;
    params.push(status);
  }
  return prisma.$queryRawUnsafe<ExchangeRequestRow[]>(sql, ...params);
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

  await prisma.$executeRawUnsafe(
    `UPDATE exchange_requests SET status = 'approved', approved_qty = ?, decided_at = NOW(3) WHERE id = ?`,
    input.approvedQty, row.id,
  );
  await addExchangeEvent(row.id, 'approved', 'admin', `Approved for ${input.approvedQty} unit(s).${input.note ? ' ' + input.note : ''}`, actor.id);

  return fetchExchangeWithEvents(row.id);
}

export async function rejectExchange(id: string, input: RejectExchangeInput, actor: OwnerActor) {
  const row = await loadExchangeOr404(id);
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
  await addExchangeEvent(row.id, 'rejected', 'admin', `Rejected: ${input.reason}`, actor.id);

  return fetchExchangeWithEvents(row.id);
}

/** Records the replacement shipment and deducts the replacement variant's stock. */
export async function shipExchange(id: string, input: ShipExchangeInput, actor: OwnerActor) {
  const row = await loadExchangeOr404(id);
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
        actor: actor.email,
      },
    });
  }

  await prisma.$executeRawUnsafe(
    `UPDATE exchange_requests SET status = 'shipped', replacement_carrier = ?, replacement_tracking = ?, shipped_at = NOW(3) WHERE id = ?`,
    input.carrier, input.tracking, row.id,
  );
  await addExchangeEvent(row.id, 'shipped', 'admin', `Replacement shipped via ${input.carrier} (${input.tracking}).`, actor.id);

  return fetchExchangeWithEvents(row.id);
}

export async function markExchangeDelivered(id: string, actor: OwnerActor) {
  const row = await loadExchangeOr404(id);
  assertExchangeStatus(row, 'shipped');

  await prisma.$executeRawUnsafe(
    `UPDATE exchange_requests SET status = 'delivered', delivered_at = NOW(3) WHERE id = ?`,
    row.id,
  );
  await addExchangeEvent(row.id, 'delivered', 'admin', 'Replacement delivered to customer.', actor.id);

  return fetchExchangeWithEvents(row.id);
}

export async function closeExchange(id: string, actor: OwnerActor) {
  const row = await loadExchangeOr404(id);
  if (!['delivered', 'approved'].includes(row.status)) {
    throw conflict(`Cannot close from status '${row.status}'.`);
  }

  await prisma.$executeRawUnsafe(
    `UPDATE exchange_requests SET status = 'closed', closed_at = NOW(3) WHERE id = ?`,
    row.id,
  );
  await addExchangeEvent(row.id, 'closed', 'admin', 'Exchange request closed.', actor.id);

  return fetchExchangeWithEvents(row.id);
}
