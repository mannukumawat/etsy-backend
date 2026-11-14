import { prisma } from '../../shared/database/prisma.js';
import { notFound } from '../../shared/errors/http-error.js';
import type { OrderTrackInput } from './order.schema.js';
import { loadLineExtras } from './order-line-extras.service.js';
import { guestTokenGrantsAccess } from './order-guest-token.service.js';
import { ORDER_INCLUDE } from './order.mapper.js';

/** Who is asking to view an order: the signed-in customer's id (if any) and the X-Order-Token header. */
export interface OrderViewer {
  customerId: string | null;
  orderToken: string | undefined;
}

/** Public "track my order" lookup by the human-readable order number AND the email it was placed under. */
export async function findOrderByNumberAndEmail(input: OrderTrackInput) {
  const order = await prisma.order.findFirst({
    where: { number: { equals: input.number.trim() }, customerEmail: input.email.trim().toLowerCase() },
    include: ORDER_INCLUDE,
  });
  // Both the order number AND the email must match — never leak an order by number alone.
  if (!order) throw notFound('No order found for that order number and email.');
  return order;
}

/** The full order by its unguessable id, only for its owner (account order) or the holder of its guest token. */
export async function getOrderForViewer(id: string, viewer: OrderViewer) {
  const order = await prisma.order.findUnique({ where: { id }, include: ORDER_INCLUDE });
  // A single, identical 404 for "no such order", "exists but belongs to another account", and
  // "exists but the guest token is missing/wrong/expired" — an order id must never, by itself, even
  // confirm that an order exists.
  if (!order) throw notFound('Order not found.');

  if (order.customerId) {
    if (viewer.customerId === null || viewer.customerId !== order.customerId) throw notFound('Order not found.');
  } else if (!guestTokenGrantsAccess(order, viewer.orderToken)) {
    throw notFound('Order not found.');
  }

  return { order, lineExtras: await loadLineExtras([order.id]) };
}
