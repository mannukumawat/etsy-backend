/**
 * Lightweight in-process request metrics (M19).
 *
 * Deliberately NOT Prometheus: the project has no Prometheus dependency and no
 * scraper, and the counters needed here (requests by route+status, 5xx total) fit
 * in a few lines. Counts live in module state, so they reset on restart/redeploy
 * and are per-instance on Vercel — the same known limitation as the in-memory rate
 * limiters (see rate-limit.middleware.ts). They are operational counters, not
 * billing data, so that trade-off is acceptable.
 *
 * `resetMetrics` exists only for tests; production code never calls it.
 */

export interface RouteCount {
  route: string;
  method: string;
  total: number;
  byStatus: Record<string, number>;
}

export interface MetricsSnapshot {
  service: string;
  startedAt: string;
  uptimeSeconds: number;
  totalRequests: number;
  requests5xx: number;
  routes: RouteCount[];
}

const startedAt = new Date();
const counts = new Map<string, RouteCount>();

export function recordRequest(method: string, route: string, status: number): void {
  const key = `${method} ${route}`;
  let row = counts.get(key);
  if (!row) {
    row = { route, method, total: 0, byStatus: {} };
    counts.set(key, row);
  }
  row.total += 1;
  const statusKey = String(status);
  row.byStatus[statusKey] = (row.byStatus[statusKey] ?? 0) + 1;
}

export function getMetricsSnapshot(): MetricsSnapshot {
  let totalRequests = 0;
  let requests5xx = 0;
  for (const row of counts.values()) {
    totalRequests += row.total;
    for (const [status, n] of Object.entries(row.byStatus)) {
      if (Number(status) >= 500) requests5xx += n;
    }
  }
  return {
    service: 'your-store-backend',
    startedAt: startedAt.toISOString(),
    uptimeSeconds: Math.floor((Date.now() - startedAt.getTime()) / 1000),
    totalRequests,
    requests5xx,
    routes: [...counts.values()].sort((a, b) => b.total - a.total),
  };
}

export function resetMetrics(): void {
  counts.clear();
}
