import { prisma } from '../../shared/database/prisma.js';
import { emitNotificationEvent } from '../../shared/events/notification-events.js';

/**
 * Low-stock alerting (M-I5): fire an owner in-app notification when a stock move
 * takes a variant DOWN across the live threshold (before > threshold >= after).
 * Moves that stay above the threshold, stay below it, or add stock never fire —
 * so the owner is alerted once per crossing, not on every sale of an already-low item.
 * Never throws: alerting must not fail the stock move that triggered it.
 */
export async function emitLowStockIfCrossed(variantId: string, before: number, after: number): Promise<void> {
  try {
    if (after >= before) return;
    const settings = await prisma.storeSettings.findUnique({ where: { id: 'singleton' }, select: { lowStockThreshold: true } });
    const threshold = settings?.lowStockThreshold ?? 5;
    if (before <= threshold || after > threshold) return;
    const variant = await prisma.productVariant.findUnique({
      where: { id: variantId },
      select: { sku: true, product: { select: { nameEn: true } } },
    });
    if (!variant) return;
    await emitNotificationEvent({
      type: 'inventory.low_stock',
      variantId,
      sku: variant.sku,
      productName: variant.product.nameEn,
      stock: after,
      threshold,
    });
  } catch {
    // Alerting is best-effort; the stock move already committed.
  }
}
