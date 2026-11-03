import { Router } from 'express';
import { requireOwner } from '../auth.js';
import { prisma } from '../db.js';
import { badRequest, conflict, notFound, route } from '../http.js';
import { parseStringMap } from '../json.js';
import { toInventoryRow, toStockAdjustment } from '../mappers.js';
import { inventoryAdjustSchema } from '../validation.js';

// Stock lives on ProductVariant.stock (the catalog milestone's column); this module adds an
// adjustment log (InventoryAdjustment) and the one endpoint that is allowed to change stock outside
// a full product save: /adjust, which uses a conditional update so concurrent adjustments can never
// push stock negative, even under retries or simultaneous requests for the same variant.

export const inventoryRouter = Router();
inventoryRouter.use(requireOwner);

const VARIANT_INCLUDE = {
  product: {
    select: {
      id: true, nameEn: true, nameHi: true, categoryId: true, status: true,
      images: { orderBy: { position: 'asc' as const }, take: 1, select: { mediaId: true } },
      options: { orderBy: { position: 'asc' as const }, include: { values: true } },
    },
  },
} as const;

function variantLabel(product: { options: Array<{ id: string; values: Array<{ id: string; labelEn: string }> }> }, optionsJson: string): string | null {
  if (!product.options.length) return null;
  const chosen = parseStringMap(optionsJson);
  const parts = product.options.map((o) => o.values.find((v) => v.id === chosen[o.id])?.labelEn).filter((v): v is string => !!v);
  return parts.length ? parts.join(' / ') : null;
}

async function lastAdjustedMap(variantIds: string[]): Promise<Map<string, Date>> {
  if (!variantIds.length) return new Map();
  const groups = await prisma.inventoryAdjustment.groupBy({ by: ['variantId'], where: { variantId: { in: variantIds } }, _max: { createdAt: true } });
  return new Map(groups.filter((g) => g._max.createdAt).map((g) => [g.variantId, g._max.createdAt as Date]));
}

inventoryRouter.get(
  '/',
  route(async (req, res) => {
    const q = String(req.query.q ?? '').trim().toLowerCase();
    const variants = await prisma.productVariant.findMany({
      where: q ? { OR: [{ sku: { contains: q } }, { product: { nameSearch: { contains: q } } }] } : undefined,
      include: VARIANT_INCLUDE,
      orderBy: [{ product: { nameEn: 'asc' } }, { position: 'asc' }],
    });
    const lastAdjusted = await lastAdjustedMap(variants.map((v) => v.id));
    const items = variants.map((v) => toInventoryRow(v, variantLabel(v.product, v.options), lastAdjusted.get(v.id) ?? null));
    res.json({ items, total: items.length });
  }),
);

inventoryRouter.get(
  '/history',
  route(async (req, res) => {
    const variantId = String(req.query.variantId ?? '').trim();
    const q = String(req.query.q ?? '').trim().toLowerCase();
    const rows = await prisma.inventoryAdjustment.findMany({
      where: {
        ...(variantId ? { variantId } : {}),
        ...(q ? { OR: [{ sku: { contains: q } }, { productNameEn: { contains: q } }] } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    res.json({ items: rows.map(toStockAdjustment), total: rows.length });
  }),
);

inventoryRouter.post(
  '/adjust',
  route(async (req, res) => {
    const input = inventoryAdjustSchema.parse(req.body);
    const variant = await prisma.productVariant.findUnique({ where: { id: input.variantId }, include: VARIANT_INCLUDE });
    if (!variant) throw notFound('Variant not found.');

    const before = variant.stock;
    const after = input.mode === 'add' ? before + input.quantity : input.mode === 'remove' ? before - input.quantity : input.quantity;
    if (after < 0) throw badRequest('This would take stock below zero.', [{ path: 'quantity', message: 'Not enough stock to remove.' }]);
    if (after > 1_000_000) throw badRequest('Stock cannot exceed 1,000,000.', [{ path: 'quantity', message: 'Too high.' }]);
    if (after === before) throw badRequest('This adjustment would not change stock.', [{ path: 'quantity', message: 'No change.' }]);

    const adjustment = await prisma.$transaction(async (tx) => {
      // Conditional update: only succeeds if stock is still `before`, so a concurrent adjustment on
      // the same variant cannot be silently overwritten by a stale read-then-write race.
      const result = await tx.productVariant.updateMany({ where: { id: input.variantId, stock: before }, data: { stock: after } });
      if (result.count === 0) throw conflict('Stock changed since this page loaded. Refresh and try again.');
      return tx.inventoryAdjustment.create({
        data: {
          productId: variant.product.id,
          variantId: variant.id,
          sku: variant.sku,
          productNameEn: variant.product.nameEn,
          productNameHi: variant.product.nameHi,
          variantLabel: variantLabel(variant.product, variant.options) ?? '',
          before,
          after,
          delta: after - before,
          reason: input.reason,
          note: input.note,
          actor: req.owner!.email,
        },
      });
    });
    res.status(201).json(toStockAdjustment(adjustment));
  }),
);
