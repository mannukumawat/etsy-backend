/**
 * Typed notification event contract between the wallet/order modules (emitters)
 * and the notification module (consumer).
 *
 * Emitters call `emitNotificationEvent(event)` after their DB transaction commits.
 * The notification module listens and creates NotificationRecord rows + queues push.
 * Firebase unavailability must NEVER fail the emitting transaction.
 */

export type NotificationEventType =
  | 'order.placed'
  | 'order.shipped'
  | 'order.delivered'
  | 'order.cancelled'
  | 'return.requested'
  | 'return.approved'
  | 'return.rejected'
  | 'return.pickup_arranged'
  | 'refund.completed'
  | 'refund.failed'
  | 'wallet.topped_up'
  | 'wallet.refunded'
  | 'wallet.spend';

export type NotificationEvent =
  | { type: 'order.placed'; orderId: string; orderNumber: string; customerId: string | null; customerEmail: string; totalPaise: number; currency: string }
  | { type: 'order.shipped'; orderId: string; orderNumber: string; customerId: string | null; customerEmail: string; carrier?: string; trackingNumber?: string }
  | { type: 'order.delivered'; orderId: string; orderNumber: string; customerId: string | null; customerEmail: string }
  | { type: 'order.cancelled'; orderId: string; orderNumber: string; customerId: string | null; customerEmail: string }
  | { type: 'return.requested'; returnId: string; returnReference: string; orderId: string; customerId: string; customerEmail: string }
  | { type: 'return.approved'; returnId: string; returnReference: string; customerId: string; customerEmail: string }
  | { type: 'return.rejected'; returnId: string; returnReference: string; customerId: string; customerEmail: string; reason?: string }
  | { type: 'return.pickup_arranged'; returnId: string; returnReference: string; customerId: string; customerEmail: string }
  | { type: 'refund.completed'; refundId: string; orderId: string; customerId: string; amountPaise: number; method: string }
  | { type: 'refund.failed'; refundId: string; orderId: string; customerId: string; amountPaise: number; method: string }
  | { type: 'wallet.topped_up'; customerId: string; amountPaise: number; walletTxId: string; newBalancePaise: number }
  | { type: 'wallet.refunded'; customerId: string; amountPaise: number; walletTxId: string; returnId?: string; newBalancePaise: number }
  | { type: 'wallet.spend'; customerId: string; amountPaise: number; walletTxId: string; orderId: string };

/** Handler registered by the notifications module. Replaced at startup; no-op until set. */
let _handler: ((event: NotificationEvent) => Promise<void>) | null = null;

export function registerNotificationEventHandler(
  handler: (event: NotificationEvent) => Promise<void>,
): void {
  _handler = handler;
}

/**
 * Fire-and-forget: emit after a DB transaction commits.
 * Errors are logged but never re-thrown — callers must not depend on this succeeding.
 */
export async function emitNotificationEvent(event: NotificationEvent): Promise<void> {
  if (!_handler) return;
  try {
    await _handler(event);
  } catch (err) {
    console.error('[notifications] handler error for event', event.type, err);
  }
}
