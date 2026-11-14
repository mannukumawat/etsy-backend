import { Router } from 'express';
import { route } from '../../shared/http/async-route.js';
import { requireOwner } from '../../shared/middleware/auth.middleware.js';
import { inventoryAdjustSchema } from './inventory.schema.js';
import { adjustStock, listInventory, listStockAdjustments } from './inventory.service.js';

export const inventoryRouter = Router();
inventoryRouter.use(requireOwner);

inventoryRouter.get(
  '/',
  route(async (req, res) => {
    const q = String(req.query.q ?? '').trim().toLowerCase();
    const items = await listInventory(q);
    res.json({ items, total: items.length });
  }),
);

inventoryRouter.get(
  '/history',
  route(async (req, res) => {
    const variantId = String(req.query.variantId ?? '').trim();
    const q = String(req.query.q ?? '').trim().toLowerCase();
    const items = await listStockAdjustments({ variantId, q });
    res.json({ items, total: items.length });
  }),
);

inventoryRouter.post(
  '/adjust',
  route(async (req, res) => {
    const input = inventoryAdjustSchema.parse(req.body);
    const adjustment = await adjustStock(input, req.owner!.email);
    res.status(201).json(adjustment);
  }),
);
