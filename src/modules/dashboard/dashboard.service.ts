import { prisma } from '../../shared/database/prisma.js';
import { badRequest } from '../../shared/errors/http-error.js';
import { L } from '../../shared/utils/localized.js';
import { ORDER_INCLUDE, toAdminOrder, type OrderRow } from '../orders/order.mapper.js';
import type { DashboardRange, DashboardSummary, SalesSeriesPoint } from './dashboard.types.js';

// Owner-only dashboard, computed live from real orders/variants — no stored metrics table. Mirrors
// admin/src/utils/metrics.ts `computeDashboard()` semantics exactly.
//
// H13: every number below is aggregated by the database (GROUP BY / SUM / COUNT). The old code
// loaded EVERY order in range with lines + events + notes and aggregated in JS — O(days x orders)
// for the daily series alone. The only row-level read left is the recent-orders list (take 5).
// Query count for one dashboard load: 8, all bounded — range totals (1), daily series (1),
// top products (1), stock counts (1), pending fulfilment (1), registered customers (1),
// low-stock threshold setting (1), recent orders (1).

/** Per-order USD conversion rate, read from the order's stored rate snapshot
 *  (`{ base, rates, asOf }` — see shared/utils/currency.ts buildRateSnapshot).
 *  Falls back to 1 when the order's currency has no snapshot entry, exactly like
 *  the old JS `rates[currency] ?? 1`. Dates are grouped in the database timezone,
 *  which is UTC on the deployed hosts (Aiven default), matching the old UTC-day
 *  grouping. */
const RATE_SQL =
  `COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(rateSnapshotJson, CONCAT('$.rates.', currency))) AS DECIMAL(20, 6)), 1)`;

const num = (v: unknown): number => Number(v ?? 0);

export async function getDashboardSummary({ from, to }: DashboardRange): Promise<DashboardSummary> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
    throw badRequest('Start date must be on or before the end date.', [{ path: 'range', message: 'Invalid range.' }]);
  }
  const rangeStart = new Date(`${from}T00:00:00.000Z`);
  const rangeEnd = new Date(`${to}T23:59:59.999Z`);

  // Range totals: order counts, gross/refund USD (each order converted at its own
  // snapshot rate, rounded per order like the old toUsd), and distinct paying
  // customers (account id, or lowercased guest email).
  const [totals] = await prisma.$queryRawUnsafe<
    Array<{
      totalOrders: unknown;
      paidOrders: unknown;
      cancelledOrders: unknown;
      failedOrders: unknown;
      grossSalesUsd: unknown;
      refundsUsd: unknown;
      customers: unknown;
    }>
  >(
    `SELECT
       COUNT(*) AS totalOrders,
       SUM(CASE WHEN paymentStatus IN ('paid', 'partially_refunded', 'refunded') THEN 1 ELSE 0 END) AS paidOrders,
       SUM(CASE WHEN fulfilmentStatus = 'cancelled' THEN 1 ELSE 0 END) AS cancelledOrders,
       SUM(CASE WHEN paymentStatus = 'failed' THEN 1 ELSE 0 END) AS failedOrders,
       COALESCE(SUM(CASE WHEN paymentStatus IN ('paid', 'partially_refunded', 'refunded') AND rate > 0 THEN ROUND(total / rate) ELSE 0 END), 0) AS grossSalesUsd,
       COALESCE(SUM(CASE WHEN paymentStatus IN ('paid', 'partially_refunded', 'refunded') AND rate > 0 THEN ROUND(refundedTotal / rate) ELSE 0 END), 0) AS refundsUsd,
       COUNT(DISTINCT CASE WHEN paymentStatus IN ('paid', 'partially_refunded', 'refunded') THEN CASE WHEN customerId IS NOT NULL THEN CONCAT('acct:', customerId) ELSE CONCAT('guest:', LOWER(customerEmail)) END END) AS customers
     FROM (
       SELECT paymentStatus, fulfilmentStatus, total, refundedTotal, customerId, customerEmail, ${RATE_SQL} AS rate
       FROM orders WHERE createdAt >= ? AND createdAt <= ?
     ) AS o`,
    rangeStart,
    rangeEnd,
  );
  const totalOrders = num(totals?.totalOrders);
  const paidOrders = num(totals?.paidOrders);
  const cancelledOrders = num(totals?.cancelledOrders);
  // 'failed' is a real payment status now (the order webhook writes it), so it is still counted.
  const failedOrders = num(totals?.failedOrders);
  const grossSalesUsd = num(totals?.grossSalesUsd);
  const refundsUsd = num(totals?.refundsUsd);
  const netRevenueUsd = grossSalesUsd - refundsUsd;
  const customers = num(totals?.customers);
  const aovUsd = paidOrders ? Math.round(grossSalesUsd / paidOrders) : 0;

  // Current state, not scoped to the date range. L-I2: archived products are excluded,
  // matching the mock dashboard — a variant of an archived product is not "low stock",
  // it is deliberately no longer sold.
  const storeSettings = await prisma.storeSettings.findUnique({ where: { id: 'singleton' } });
  const lowStockThreshold = storeSettings?.lowStockThreshold ?? 5;
  const [stock] = await prisma.$queryRawUnsafe<Array<{ lowStockVariants: unknown; outOfStockVariants: unknown }>>(
    `SELECT
       SUM(CASE WHEN v.stock > 0 AND v.stock <= ? THEN 1 ELSE 0 END) AS lowStockVariants,
       SUM(CASE WHEN v.stock = 0 THEN 1 ELSE 0 END) AS outOfStockVariants
     FROM product_variants v JOIN products p ON p.id = v.productId WHERE p.status <> 'archived'`,
    lowStockThreshold,
  );
  const lowStockVariants = num(stock?.lowStockVariants);
  const outOfStockVariants = num(stock?.outOfStockVariants);
  const [pendingFulfilment, totalRegisteredCustomers] = await Promise.all([
    prisma.order.count({
      where: { paymentStatus: { in: ['paid', 'partially_refunded'] }, fulfilmentStatus: { in: ['unfulfilled', 'processing'] } },
    }),
    // Lifetime count, independent of the date range — distinct from `customers` (paying buyers within range).
    prisma.customer.count(),
  ]);

  // One point per day in range, grouped by the database; days without orders are
  // filled with zeros below so the series always covers the whole range.
  const dayRows = await prisma.$queryRawUnsafe<Array<{ day: Date | string; netUsd: unknown; orders: unknown }>>(
    `SELECT DATE(createdAt) AS day,
       COALESCE(SUM(CASE WHEN rate > 0 THEN ROUND((total - refundedTotal) / rate) ELSE 0 END), 0) AS netUsd,
       COUNT(*) AS orders
     FROM (
       SELECT createdAt, total, refundedTotal, ${RATE_SQL} AS rate
       FROM orders WHERE createdAt >= ? AND createdAt <= ? AND paymentStatus IN ('paid', 'partially_refunded', 'refunded')
     ) AS o GROUP BY DATE(createdAt) ORDER BY day ASC`,
    rangeStart,
    rangeEnd,
  );
  const byDay = new Map<string, { netUsd: number; orders: number }>();
  for (const r of dayRows) {
    const day = r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day).slice(0, 10);
    byDay.set(day, { netUsd: num(r.netUsd), orders: num(r.orders) });
  }
  const salesSeries: SalesSeriesPoint[] = [];
  for (let d = new Date(rangeStart); d <= rangeEnd; d.setUTCDate(d.getUTCDate() + 1)) {
    const dayStr = d.toISOString().slice(0, 10);
    const day = byDay.get(dayStr) ?? { netUsd: 0, orders: 0 };
    salesSeries.push({ date: dayStr, netUsd: day.netUsd, orders: day.orders });
  }

  // Top products by revenue, excluding fully-refunded orders. The per-line USD
  // conversion uses the owning order's snapshot rate.
  const topRows = await prisma.$queryRawUnsafe<
    Array<{ productId: string; nameEn: string; nameHi: string; units: unknown; revenueUsd: unknown }>
  >(
    `SELECT l.productId AS productId, MAX(l.nameEn) AS nameEn, MAX(l.nameHi) AS nameHi,
       SUM(l.quantity) AS units,
       COALESCE(SUM(CASE WHEN o.rate > 0 THEN ROUND(l.lineTotal / o.rate) ELSE 0 END), 0) AS revenueUsd
     FROM order_lines l
     JOIN (
       SELECT id, ${RATE_SQL} AS rate FROM orders
       WHERE createdAt >= ? AND createdAt <= ? AND paymentStatus IN ('paid', 'partially_refunded')
     ) AS o ON o.id = l.orderId
     GROUP BY l.productId ORDER BY revenueUsd DESC, units DESC LIMIT 5`,
    rangeStart,
    rangeEnd,
  );
  const topProducts = topRows.map((r: { productId: string; nameEn: string; nameHi: string; units: unknown; revenueUsd: unknown }) => ({
    productId: r.productId,
    name: L(r.nameEn, r.nameHi),
    units: num(r.units),
    revenueUsd: num(r.revenueUsd),
  }));

  // Recent orders: a separate bounded query, never a slice of the whole range.
  const recentOrders = await prisma.order.findMany({
    where: { createdAt: { gte: rangeStart, lte: rangeEnd } },
    include: ORDER_INCLUDE,
    orderBy: { createdAt: 'desc' },
    take: 5,
  });

  return {
    range: { from, to },
    grossSalesUsd,
    refundsUsd,
    netRevenueUsd,
    totalOrders,
    paidOrders,
    cancelledOrders,
    failedOrders,
    aovUsd,
    customers,
    totalRegisteredCustomers,
    pendingFulfilment,
    lowStockVariants,
    outOfStockVariants,
    salesSeries,
    topProducts,
    recentOrders: recentOrders.map((o: OrderRow) => toAdminOrder(o)),
  };
}
