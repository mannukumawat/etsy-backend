import { Router } from 'express';
import { route } from '../../shared/http/async-route.js';
import { requireOwner } from '../../shared/middleware/auth.middleware.js';
import { getDashboardSummary } from './dashboard.service.js';

// Owner-only dashboard (metrics are computed live in dashboard.service.ts).

export const adminDashboardRouter = Router();
adminDashboardRouter.use(requireOwner);

adminDashboardRouter.get(
  '/',
  route(async (req, res) => {
    const from = String(req.query.from ?? '');
    const to = String(req.query.to ?? '');
    res.json(await getDashboardSummary({ from, to }));
  }),
);
