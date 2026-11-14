import type { L } from '../../shared/utils/localized.js';
import type { toAdminOrder } from '../orders/order.mapper.js';

/** Inclusive range of UTC calendar days, both `YYYY-MM-DD`. */
export interface DashboardRange {
  from: string;
  to: string;
}

export interface SalesSeriesPoint {
  date: string;
  netUsd: number;
  orders: number;
}

export interface TopProduct {
  productId: string;
  name: ReturnType<typeof L>;
  units: number;
  revenueUsd: number;
}

export interface DashboardSummary {
  range: DashboardRange;
  grossSalesUsd: number;
  refundsUsd: number;
  netRevenueUsd: number;
  totalOrders: number;
  paidOrders: number;
  cancelledOrders: number;
  failedOrders: number;
  aovUsd: number;
  customers: number;
  totalRegisteredCustomers: number;
  pendingFulfilment: number;
  lowStockVariants: number;
  outOfStockVariants: number;
  salesSeries: SalesSeriesPoint[];
  topProducts: TopProduct[];
  recentOrders: Array<ReturnType<typeof toAdminOrder>>;
}
