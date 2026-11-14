import { Router } from 'express';
import { requireOwner } from '../../shared/middleware/auth.middleware.js';
import { route } from '../../shared/http/async-route.js';
import { getAdminCustomerDetail, listAdminCustomers } from './admin-customer.service.js';

// Read-only owner view of customers (accounts + guest buyers), derived from accounts and orders.

export const adminCustomersRouter = Router();
adminCustomersRouter.use(requireOwner);

adminCustomersRouter.get(
  '/',
  route(async (req, res) => {
    const q = String(req.query.q ?? '').trim().toLowerCase();
    const kind = String(req.query.kind ?? '').trim();
    const sort = String(req.query.sort ?? '');
    const dir = req.query.dir === 'asc' ? 1 : -1;
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(String(req.query.pageSize ?? '20'), 10) || 20));

    res.json(await listAdminCustomers({ q, kind, sort, dir, page, pageSize }));
  }),
);

adminCustomersRouter.get(
  '/:id',
  route(async (req, res) => {
    res.json(await getAdminCustomerDetail(req.params.id));
  }),
);
