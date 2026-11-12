import { Router } from 'express';
import { requireOwner } from '../auth.js';
import { prisma } from '../db.js';
import { badRequest, route } from '../http.js';
import { L, ORDER_INCLUDE, toAdminOrder } from '../mappers.js';

// Owner-only dashboard, computed live from real orders/variants — no stored metrics table. Mirrors
// admin/src/utils/metrics.ts `computeDashboard()` semantics exactly.

export const adminDashboardRouter = Router();
adminDashboardRouter.use(requireOwner);

const wasPaid = (status: string) => status === 'paid' || status === 'partially_refunded' || status === 'refunded';
const toUsd = (amount: number, rate: number) => (rate > 0 ? Math.round(amount / rate) : 0);

adminDashboardRouter.get(
  '/',
  route(async (req, res) => {
    const from = String(req.query.from ?? '');
    const to = String(req.query.to ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
      throw badRequest('Start date must be on or before the end date.', [{ path: 'range', message: 'Invalid range.' }]);
    }
    const rangeStart = new Date(`${from}T00:00:00.000Z`);
    const rangeEnd = new Date(`${to}T23:59:59.999Z`);

    const ordersInRange = await prisma.order.findMany({
      where: { createdAt: { gte: rangeStart, lte: rangeEnd } },
      include: ORDER_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });

    const rateOf = (o: (typeof ordersInRange)[number]) => (JSON.parse(o.rateSnapshotJson) as { rates: Record<string, number> }).rates[o.currency] ?? 1;

    const paidOrders = ordersInRange.filter((o) => wasPaid(o.paymentStatus));
    const grossSalesUsd = paidOrders.reduce((s, o) => s + toUsd(o.total, rateOf(o)), 0);
    const refundsUsd = paidOrders.reduce((s, o) => s + toUsd(o.refundedTotal, rateOf(o)), 0);
    const netRevenueUsd = grossSalesUsd - refundsUsd;
    const cancelledOrders = ordersInRange.filter((o) => o.fulfilmentStatus === 'cancelled').length;
    const failedOrders = ordersInRange.filter((o) => o.paymentStatus === 'failed').length;
    const aovUsd = paidOrders.length ? Math.round(grossSalesUsd / paidOrders.length) : 0;
    const customers = new Set(paidOrders.map((o) => (o.customerId ? `acct:${o.customerId}` : `guest:${o.customerEmail.toLowerCase()}`))).size;

    // Current state, not scoped to the date range.
    const variants = await prisma.productVariant.findMany({ select: { stock: true } });
    const [storeSettings] = await Promise.all([prisma.storeSettings.findUnique({ where: { id: 'singleton' } })]);
    const lowStockThreshold = storeSettings?.lowStockThreshold ?? 5;
    const lowStockVariants = variants.filter((v) => v.stock > 0 && v.stock <= lowStockThreshold).length;
    const outOfStockVariants = variants.filter((v) => v.stock === 0).length;
    const pendingFulfilment = await prisma.order.count({
      where: { paymentStatus: { in: ['paid', 'partially_refunded'] }, fulfilmentStatus: { in: ['unfulfilled', 'processing'] } },
    });
    // Lifetime count, independent of the date range — distinct from `customers` (paying buyers within range).
    const totalRegisteredCustomers = await prisma.customer.count();

    // One point per day in range.
    const salesSeries: Array<{ date: string; netUsd: number; orders: number }> = [];
    for (let d = new Date(rangeStart); d <= rangeEnd; d.setUTCDate(d.getUTCDate() + 1)) {
      const dayStr = d.toISOString().slice(0, 10);
      const dayOrders = paidOrders.filter((o) => o.createdAt.toISOString().slice(0, 10) === dayStr);
      salesSeries.push({ date: dayStr, netUsd: dayOrders.reduce((s, o) => s + toUsd(o.total - o.refundedTotal, rateOf(o)), 0), orders: dayOrders.length });
    }

    // Top products by revenue, excluding fully-refunded orders.
    const revenueByProduct = new Map<string, { nameEn: string; nameHi: string; units: number; revenueUsd: number }>();
    for (const o of paidOrders) {
      if (o.paymentStatus === 'refunded') continue;
      const rate = rateOf(o);
      for (const line of o.lines) {
        const entry = revenueByProduct.get(line.productId) ?? { nameEn: line.nameEn, nameHi: line.nameHi, units: 0, revenueUsd: 0 };
        entry.units += line.quantity;
        entry.revenueUsd += toUsd(line.lineTotal, rate);
        revenueByProduct.set(line.productId, entry);
      }
    }
    const topProducts = [...revenueByProduct.entries()]
      .map(([productId, v]) => ({ productId, name: L(v.nameEn, v.nameHi), units: v.units, revenueUsd: v.revenueUsd }))
      .sort((a, b) => b.revenueUsd - a.revenueUsd || b.units - a.units)
      .slice(0, 5);

    res.json({
      range: { from, to },
      grossSalesUsd,
      refundsUsd,
      netRevenueUsd,
      totalOrders: ordersInRange.length,
      paidOrders: paidOrders.length,
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
      recentOrders: ordersInRange.slice(0, 5).map((o) => toAdminOrder(o)),
    });
  }),
);
