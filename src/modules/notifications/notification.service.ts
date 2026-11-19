/**
 * Core notification service: creates NotificationRecord rows, deduplicates,
 * handles token upsert/delete, and provides inbox CRUD.
 *
 * Schema notes:
 *  - NotificationRecord.readAt: DateTime? (null = unread)
 *  - NotificationRecord has NO referenceId field — dedup uses (recipientId, event, title) within 60s
 *  - NotificationSend uses senderId, recipientType ('one'|'all'), recipientId, successCount, failCount, sentAt
 */
import { prisma } from '../../shared/database/prisma.js';
import { notFound } from '../../shared/errors/http-error.js';
import type { NotificationEvent } from '../../shared/events/notification-events.js';
import type {
  NotificationPageDto,
  NotificationRecordDto,
  NotificationSendDto,
  SendNotificationInput,
  UnreadCountDto,
} from './notification.types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toDto(r: {
  id: string;
  kind: string;
  recipientId: string;
  event: string;
  title: string;
  body: string;
  link: string;
  readAt: Date | null;
  pushStatus: string;
  createdAt: Date;
}): NotificationRecordDto {
  return {
    id: r.id,
    kind: r.kind as 'customer' | 'owner',
    recipientId: r.recipientId,
    event: r.event,
    title: r.title,
    body: r.body,
    link: r.link,
    isRead: r.readAt !== null,
    pushStatus: r.pushStatus,
    createdAt: r.createdAt.toISOString(),
  };
}

/** Returns true if a duplicate record exists within last 60 seconds for same (recipientId, event, title). */
async function isDuplicate(recipientId: string, event: string, title: string): Promise<boolean> {
  const since = new Date(Date.now() - 60_000);
  const count = await prisma.notificationRecord.count({
    where: { recipientId, event, title, createdAt: { gte: since } },
  });
  return count > 0;
}

/** Create one inbox record (after dedup check). Returns null if duplicate. */
async function createRecord(params: {
  kind: 'customer' | 'owner';
  recipientId: string;
  customerId: string | null;
  event: string;
  title: string;
  body: string;
  link: string;
}) {
  if (await isDuplicate(params.recipientId, params.event, params.title)) return null;
  return prisma.notificationRecord.create({
    data: {
      kind: params.kind,
      recipientId: params.recipientId,
      customerId: params.customerId,
      event: params.event,
      title: params.title,
      body: params.body,
      link: params.link,
    },
  });
}

// ---------------------------------------------------------------------------
// Event handler (called by emitNotificationEvent)
// ---------------------------------------------------------------------------

export async function handleNotificationEvent(event: NotificationEvent): Promise<void> {
  switch (event.type) {
    case 'order.placed': {
      await createRecord({
        kind: 'owner',
        recipientId: 'owner',
        customerId: null,
        event: event.type,
        title: `New order ${event.orderNumber}`,
        body: `A new order has been placed.`,
        link: `/orders/${event.orderId}`,
      });
      if (event.customerId) {
        await createRecord({
          kind: 'customer',
          recipientId: event.customerId,
          customerId: event.customerId,
          event: event.type,
          title: 'Order confirmed',
          body: `Your order ${event.orderNumber} has been placed successfully.`,
          link: `/account/orders/${event.orderId}`,
        });
      }
      break;
    }

    case 'order.shipped': {
      if (!event.customerId) break;
      await createRecord({
        kind: 'customer',
        recipientId: event.customerId,
        customerId: event.customerId,
        event: event.type,
        title: 'Your order has shipped',
        body: event.carrier
          ? `Order ${event.orderNumber} is on its way via ${event.carrier}.`
          : `Order ${event.orderNumber} is on its way.`,
        link: `/account/orders/${event.orderId}`,
      });
      break;
    }

    case 'order.delivered': {
      if (!event.customerId) break;
      await createRecord({
        kind: 'customer',
        recipientId: event.customerId,
        customerId: event.customerId,
        event: event.type,
        title: 'Order delivered',
        body: `Order ${event.orderNumber} has been delivered.`,
        link: `/account/orders/${event.orderId}`,
      });
      break;
    }

    case 'order.cancelled': {
      if (!event.customerId) break;
      await createRecord({
        kind: 'customer',
        recipientId: event.customerId,
        customerId: event.customerId,
        event: event.type,
        title: 'Order cancelled',
        body: `Order ${event.orderNumber} has been cancelled.`,
        link: `/account/orders/${event.orderId}`,
      });
      break;
    }

    case 'return.requested': {
      await createRecord({
        kind: 'owner',
        recipientId: 'owner',
        customerId: null,
        event: event.type,
        title: `Return request: ${event.returnReference}`,
        body: `A return has been requested.`,
        link: `/returns/${event.returnId}`,
      });
      break;
    }

    case 'return.approved': {
      await createRecord({
        kind: 'customer',
        recipientId: event.customerId,
        customerId: event.customerId,
        event: event.type,
        title: 'Return approved',
        body: `Your return request ${event.returnReference} has been approved.`,
        link: `/account/returns/${event.returnReference}`,
      });
      break;
    }

    case 'return.rejected': {
      await createRecord({
        kind: 'customer',
        recipientId: event.customerId,
        customerId: event.customerId,
        event: event.type,
        title: 'Return update',
        body: `Your return request ${event.returnReference} could not be approved.`,
        link: `/account/returns/${event.returnReference}`,
      });
      break;
    }

    case 'return.pickup_arranged': {
      await createRecord({
        kind: 'customer',
        recipientId: event.customerId,
        customerId: event.customerId,
        event: event.type,
        title: 'Pickup arranged',
        body: `Pickup for your return ${event.returnReference} has been arranged.`,
        link: `/account/returns/${event.returnReference}`,
      });
      break;
    }

    case 'refund.completed': {
      await createRecord({
        kind: 'customer',
        recipientId: event.customerId,
        customerId: event.customerId,
        event: event.type,
        title: 'Refund processed',
        body: `Your refund has been processed successfully.`,
        link: `/account/orders/${event.orderId}`,
      });
      break;
    }

    case 'refund.failed': {
      await createRecord({
        kind: 'customer',
        recipientId: event.customerId,
        customerId: event.customerId,
        event: event.type,
        title: 'Refund issue',
        body: `There was an issue processing your refund. Please contact support.`,
        link: `/account/orders/${event.orderId}`,
      });
      await createRecord({
        kind: 'owner',
        recipientId: 'owner',
        customerId: null,
        event: event.type,
        title: `Refund failed: ${event.orderId}`,
        body: `A refund failed for order ${event.orderId}.`,
        link: `/orders/${event.orderId}`,
      });
      break;
    }

    case 'wallet.topped_up': {
      await createRecord({
        kind: 'customer',
        recipientId: event.customerId,
        customerId: event.customerId,
        event: event.type,
        title: 'Wallet topped up',
        body: `Your wallet has been credited.`,
        link: `/account/wallet`,
      });
      break;
    }

    case 'wallet.refunded': {
      await createRecord({
        kind: 'customer',
        recipientId: event.customerId,
        customerId: event.customerId,
        event: event.type,
        title: 'Refund to wallet',
        body: `Your refund has been added to your wallet.`,
        link: `/account/wallet`,
      });
      break;
    }

    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Token management
// ---------------------------------------------------------------------------

const MAX_TOKENS_PER_CUSTOMER = 5;

export async function upsertFcmToken(customerId: string, token: string): Promise<void> {
  const existing = await prisma.fcmToken.findUnique({ where: { token } });
  if (existing) {
    await prisma.fcmToken.update({ where: { token }, data: { customerId, lastSeen: new Date() } });
    return;
  }

  const count = await prisma.fcmToken.count({ where: { customerId } });
  if (count >= MAX_TOKENS_PER_CUSTOMER) {
    const oldest = await prisma.fcmToken.findFirst({
      where: { customerId },
      orderBy: { lastSeen: 'asc' },
      select: { id: true },
    });
    if (oldest) await prisma.fcmToken.delete({ where: { id: oldest.id } });
  }

  await prisma.fcmToken.create({ data: { customerId, token } });
}

export async function deleteFcmToken(token: string, customerId: string): Promise<void> {
  await prisma.fcmToken.deleteMany({ where: { token, customerId } });
}

export async function deleteAllFcmTokensForCustomer(customerId: string): Promise<void> {
  await prisma.fcmToken.deleteMany({ where: { customerId } });
}

// ---------------------------------------------------------------------------
// Customer inbox
// ---------------------------------------------------------------------------

export async function listCustomerNotifications(
  customerId: string,
  cursor?: string,
  limit = 20,
): Promise<NotificationPageDto> {
  const cursorParts = cursor ? cursor.split('_') : null;
  const cursorDate = cursorParts ? new Date(cursorParts[0] ?? '') : undefined;
  const cursorId = cursorParts ? (cursorParts[1] ?? '') : undefined;

  const rows = await prisma.notificationRecord.findMany({
    where: {
      recipientId: customerId,
      kind: 'customer',
      ...(cursorDate
        ? { OR: [{ createdAt: { lt: cursorDate } }, { createdAt: cursorDate, id: { lt: cursorId } }] }
        : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  const nextCursor = hasMore && last ? `${last.createdAt.toISOString()}_${last.id}` : null;

  return { items: items.map(toDto), nextCursor };
}

export async function getCustomerUnreadCount(customerId: string): Promise<UnreadCountDto> {
  const count = await prisma.notificationRecord.count({
    where: { recipientId: customerId, kind: 'customer', readAt: null },
  });
  return { count };
}

export async function markCustomerNotificationRead(id: string, customerId: string): Promise<void> {
  const record = await prisma.notificationRecord.findUnique({ where: { id } });
  if (!record || record.recipientId !== customerId) throw notFound('Notification not found.');
  if (record.readAt === null) {
    await prisma.notificationRecord.update({ where: { id }, data: { readAt: new Date() } });
  }
}

export async function markAllCustomerNotificationsRead(customerId: string): Promise<void> {
  await prisma.notificationRecord.updateMany({
    where: { recipientId: customerId, kind: 'customer', readAt: null },
    data: { readAt: new Date() },
  });
}

// ---------------------------------------------------------------------------
// Owner inbox
// ---------------------------------------------------------------------------

export async function listOwnerNotifications(
  cursor?: string,
  limit = 20,
): Promise<NotificationPageDto> {
  const cursorParts = cursor ? cursor.split('_') : null;
  const cursorDate = cursorParts ? new Date(cursorParts[0] ?? '') : undefined;
  const cursorId = cursorParts ? (cursorParts[1] ?? '') : undefined;

  const rows = await prisma.notificationRecord.findMany({
    where: {
      recipientId: 'owner',
      kind: 'owner',
      ...(cursorDate
        ? { OR: [{ createdAt: { lt: cursorDate } }, { createdAt: cursorDate, id: { lt: cursorId } }] }
        : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  const nextCursor = hasMore && last ? `${last.createdAt.toISOString()}_${last.id}` : null;

  return { items: items.map(toDto), nextCursor };
}

export async function getOwnerUnreadCount(): Promise<UnreadCountDto> {
  const count = await prisma.notificationRecord.count({
    where: { recipientId: 'owner', kind: 'owner', readAt: null },
  });
  return { count };
}

export async function markOwnerNotificationRead(id: string): Promise<void> {
  const record = await prisma.notificationRecord.findUnique({ where: { id } });
  if (!record || record.recipientId !== 'owner') throw notFound('Notification not found.');
  if (record.readAt === null) {
    await prisma.notificationRecord.update({ where: { id }, data: { readAt: new Date() } });
  }
}

export async function markAllOwnerNotificationsRead(): Promise<void> {
  await prisma.notificationRecord.updateMany({
    where: { recipientId: 'owner', kind: 'owner', readAt: null },
    data: { readAt: new Date() },
  });
}

// ---------------------------------------------------------------------------
// Admin send (composer)
// ---------------------------------------------------------------------------

/** OWNER_ID placeholder for senderId. */
const OWNER_SENDER_ID = 'owner';

export async function sendAdminNotification(input: SendNotificationInput): Promise<{ recipientCount: number; sendId: string }> {
  let recipientCount = 0;

  if (input.customerId === null) {
    const customers = await prisma.customer.findMany({ select: { id: true } });
    recipientCount = customers.length;
    for (const c of customers) {
      await createRecord({
        kind: 'customer',
        recipientId: c.id,
        customerId: c.id,
        event: 'admin.send',
        title: input.title,
        body: input.body,
        link: input.link ?? '',
      });
    }
  } else {
    const customer = await prisma.customer.findUnique({ where: { id: input.customerId }, select: { id: true } });
    if (!customer) throw notFound('Customer not found.');
    recipientCount = 1;
    await createRecord({
      kind: 'customer',
      recipientId: input.customerId,
      customerId: input.customerId,
      event: 'admin.send',
      title: input.title,
      body: input.body,
      link: input.link ?? '',
    });
  }

  const send = await prisma.notificationSend.create({
    data: {
      senderId: OWNER_SENDER_ID,
      recipientType: input.customerId === null ? 'all' : 'one',
      recipientId: input.customerId,
      title: input.title,
      body: input.body,
      successCount: recipientCount,
      failCount: 0,
    },
  });

  return { recipientCount, sendId: send.id };
}

export async function listNotificationSends(limit = 50): Promise<NotificationSendDto[]> {
  const rows = await prisma.notificationSend.findMany({
    orderBy: { sentAt: 'desc' },
    take: limit,
  });
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    body: r.body,
    recipientType: r.recipientType as 'one' | 'all',
    recipientId: r.recipientId,
    successCount: r.successCount,
    failCount: r.failCount,
    sentAt: r.sentAt.toISOString(),
  }));
}
