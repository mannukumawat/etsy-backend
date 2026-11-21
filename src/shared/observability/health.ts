import { Router, type Request, type Response } from 'express';
import { getMetricsSnapshot } from './metrics.js';

/**
 * Operational probes (M19), mounted at `/api/health` in `createApp()` BEFORE the
 * public-API rate limiter — a readiness probe must never be throttled by the
 * thing it is probing, and neither probe needs auth (they expose no data).
 *
 * - `GET /api/health/ready` — readiness: 200 only when the database answers a
 *   cheap `SELECT 1`, 503 otherwise. Liveness stays on the existing `GET /health`,
 *   which is unchanged.
 * - `GET /api/health/metrics` — in-process request counters (see metrics.ts).
 *   Counts reset on restart and are per-instance on Vercel.
 */

export interface HealthRouterDeps {
  /** Injected so tests can fake the database without importing Prisma. */
  checkDatabase: () => Promise<void>;
}

export function createHealthRouter(deps: HealthRouterDeps): Router {
  const router = Router();

  router.get('/ready', async (_req: Request, res: Response) => {
    try {
      await deps.checkDatabase();
    } catch {
      return res.status(503).json({
        ok: false,
        status: 'not_ready',
        service: 'your-store-backend',
        error: 'database_unreachable',
        time: new Date().toISOString(),
      });
    }
    return res.json({ ok: true, status: 'ready', service: 'your-store-backend', time: new Date().toISOString() });
  });

  router.get('/metrics', (_req: Request, res: Response) => {
    res.json(getMetricsSnapshot());
  });

  return router;
}
