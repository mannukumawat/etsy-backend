import { Router } from 'express';
import { route } from '../../shared/http/async-route.js';
import { requireOwner } from '../../shared/middleware/auth.middleware.js';
import { inventoryAdjustSchema } from './inventory.schema.js';
import { adjustStock, exportStockAdjustmentsCsv, listInventory, listStockAdjustments } from './inventory.service.js';

export const inventoryRouter = Router();
inventoryRouter.use(requireOwner);

const str = (v: unknown) => String(v ?? '').trim();
const pageOf = (v: unknown) => Math.max(1, Number(v) || 1);
const pageSizeOf = (v: unknown, fallback: number) => Math.min(100, Math.max(1, Number(v) || fallback));

inventoryRouter.get(
  '/',
  route(async (req, res) => {
    // M-I1: server-side search/paging/filtering — the admin now passes q + filters,
    // so the full-catalogue download per visit is gone.
    const result = await listInventory({
      q: str(req.query.q).toLowerCase(),
      stock: str(req.query.stock),
      category: str(req.query.category),
      status: str(req.query.status),
      sort: str(req.query.sort) || 'product',
      dir: req.query.dir === 'desc' ? 'desc' : 'asc',
      page: pageOf(req.query.page),
      pageSize: pageSizeOf(req.query.pageSize, 25),
    });
    res.json(result);
  }),
);

inventoryRouter.get(
  '/history',
  route(async (req, res) => {
    // M-I1: history is paged + filterable (reason/actor/date/search) instead of a
    // hard-capped take:500 the admin then sliced to 200.
    const result = await listStockAdjustments({
      variantId: str(req.query.variantId),
      q: str(req.query.q).toLowerCase(),
      reason: str(req.query.reason),
      actor: str(req.query.actor),
      from: str(req.query.from),
      to: str(req.query.to),
      page: pageOf(req.query.page),
      pageSize: pageSizeOf(req.query.pageSize, 25),
    });
    res.json(result);
  }),
);

/** GET /history/export — the same filtered history as a CSV download (M-I1). */
inventoryRouter.get(
  '/history/export',
  route(async (req, res) => {
    const csv = await exportStockAdjustmentsCsv({
      variantId: str(req.query.variantId),
      q: str(req.query.q).toLowerCase(),
      reason: str(req.query.reason),
      actor: str(req.query.actor),
      from: str(req.query.from),
      to: str(req.query.to),
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="stock-adjustments.csv"');
    res.send(csv);
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
