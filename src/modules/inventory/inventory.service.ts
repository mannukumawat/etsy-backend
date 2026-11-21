import { prisma } from '../../shared/database/prisma.js';
import { badRequest, conflict, notFound } from '../../shared/errors/http-error.js';
import { parseStringMap } from '../../shared/utils/json.js';
import { toInventoryRow, toStockAdjustment } from './inventory.mapper.js';
import { MAX_STOCK_PER_VARIANT, type InventoryAdjustInput } from './inventory.schema.js';
import { emitLowStockIfCrossed } from './low-stock-alert.js';

// Stock lives on ProductVariant.stock (the catalog milestone's column); this module adds an
// adjustment log (InventoryAdjustment) and the one operation that is allowed to change stock outside
// a full product save: adjustStock, which uses a conditional update so concurrent adjustments can never
// push stock negative, even under retries or simultaneous requests for the same variant.

const VARIANT_INCLUDE = {
  // L-I7: with `include`, Prisma returns all scalar fields of the variant by
  // default — including `imageIds` — so the row can prefer the variant image
  // (like the mock) instead of always using the product's first image.
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
  // L-I7: options exist but none resolve (e.g. the option was rebuilt) — say so
  // instead of returning null, which the admin renders as "Single variant".
  if (!parts.length) return 'Variant options unavailable';
  return parts.join(' / ');
}

async function lastAdjustedMap(variantIds: string[]): Promise<Map<string, Date>> {
  if (!variantIds.length) return new Map();
  const groups = await prisma.inventoryAdjustment.groupBy({ by: ['variantId'], where: { variantId: { in: variantIds } }, _max: { createdAt: true } });
  return new Map(groups.filter((g) => g._max.createdAt).map((g) => [g.variantId, g._max.createdAt as Date]));
}

/** Every variant with its stock and the time of its last adjustment; `q` is already trimmed + lower-cased.
 *  M-I1: server-side pagination + filters (stock state, category, product status) + sorting.
 *  The old full-catalogue download per visit is gone; the admin passes `q` now, so the
 *  backend search is live code instead of dead code. */
export interface InventoryListQuery {
  q: string;
  /** 'low' (1..threshold) | 'out' (<= 0) | 'in' (> threshold) | '' (all). */
  stock: string;
  category: string;
  status: string;
  /** 'product' | 'sku' | 'stock'. */
  sort: string;
  dir: 'asc' | 'desc';
  page: number;
  pageSize: number;
}

export async function listInventory(query: InventoryListQuery) {
  const settings = await prisma.storeSettings.findUnique({ where: { id: 'singleton' }, select: { lowStockThreshold: true } });
  const threshold = settings?.lowStockThreshold ?? 5;
  const q = query.q;
  const stockWhere =
    query.stock === 'low' ? { stock: { gt: 0, lte: threshold } }
    : query.stock === 'out' ? { stock: { lte: 0 } }
    : query.stock === 'in' ? { stock: { gt: threshold } }
    : {};
  // `q` matches SKU *or* product name (top-level OR, AND-ed with the other filters);
  // category/status constrain the product relation.
  const productWhere: Record<string, unknown> = {};
  if (query.category) productWhere.categoryId = query.category;
  if (query.status) productWhere.status = query.status;
  const where = {
    ...stockWhere,
    ...(Object.keys(productWhere).length ? { product: productWhere } : {}),
    ...(q ? { OR: [{ sku: { contains: q } }, { product: { nameSearch: { contains: q } } }] } : {}),
  };
  const total = await prisma.productVariant.count({ where });
  const pageSize = Math.min(100, Math.max(1, query.pageSize));
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, query.page), pageCount);
  const orderBy =
    query.sort === 'sku' ? [{ sku: query.dir }] as const
    : query.sort === 'stock' ? [{ stock: query.dir }, { sku: 'asc' }] as const
    : [{ product: { nameEn: query.dir } }, { position: 'asc' }] as const;
  const variants = await prisma.productVariant.findMany({
    where,
    include: VARIANT_INCLUDE,
    orderBy,
    skip: (page - 1) * pageSize,
    take: pageSize,
  });
  const lastAdjusted = await lastAdjustedMap(variants.map((v) => v.id));
  return {
    items: variants.map((v) => toInventoryRow(v, variantLabel(v.product, v.options), lastAdjusted.get(v.id) ?? null)),
    total,
    page,
    pageSize,
    pageCount,
  };
}

/** Newest-first adjustment log with server pagination and reason/actor/date/search filters (M-I1). */
export interface StockAdjustmentQuery {
  variantId: string;
  q: string;
  reason: string;
  actor: string;
  from: string;
  to: string;
  page: number;
  pageSize: number;
}

export async function listStockAdjustments(filter: StockAdjustmentQuery) {
  const where = {
    ...(filter.variantId ? { variantId: filter.variantId } : {}),
    ...(filter.q ? { OR: [{ sku: { contains: filter.q } }, { productNameEn: { contains: filter.q } }] } : {}),
    ...(filter.reason ? { reason: filter.reason } : {}),
    ...(filter.actor ? { actor: { contains: filter.actor } } : {}),
    ...(filter.from || filter.to
      ? { createdAt: { ...(filter.from ? { gte: new Date(`${filter.from}T00:00:00.000Z`) } : {}), ...(filter.to ? { lt: new Date(`${filter.to}T23:59:59.999Z`) } : {}) } }
      : {}),
  };
  const total = await prisma.inventoryAdjustment.count({ where });
  const pageSize = Math.min(100, Math.max(1, filter.pageSize));
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, filter.page), pageCount);
  const rows = await prisma.inventoryAdjustment.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    skip: (page - 1) * pageSize,
    take: pageSize,
  });
  return { items: rows.map(toStockAdjustment), total, page, pageSize, pageCount };
}

/** CSV export of the adjustment history with the same filters as the list (M-I1). */
export async function exportStockAdjustmentsCsv(filter: Omit<StockAdjustmentQuery, 'page' | 'pageSize'>): Promise<string> {
  const where = {
    ...(filter.variantId ? { variantId: filter.variantId } : {}),
    ...(filter.q ? { OR: [{ sku: { contains: filter.q } }, { productNameEn: { contains: filter.q } }] } : {}),
    ...(filter.reason ? { reason: filter.reason } : {}),
    ...(filter.actor ? { actor: { contains: filter.actor } } : {}),
    ...(filter.from || filter.to
      ? { createdAt: { ...(filter.from ? { gte: new Date(`${filter.from}T00:00:00.000Z`) } : {}), ...(filter.to ? { lt: new Date(`${filter.to}T23:59:59.999Z`) } : {}) } }
      : {}),
  };
  const rows = await prisma.inventoryAdjustment.findMany({ where, orderBy: { createdAt: 'desc' }, take: 5000 });
  const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
  const lines = ['Date,SKU,Product,Variant,Before,After,Change,Reason,Note,Actor'];
  for (const r of rows) {
    lines.push([r.createdAt.toISOString(), r.sku, r.productNameEn, r.variantLabel, r.before, r.after, r.delta, r.reason, r.note ?? '', r.actor].map(esc).join(','));
  }
  return lines.join('\n');
}

export async function adjustStock(input: InventoryAdjustInput, actor: string) {
  const variant = await prisma.productVariant.findUnique({ where: { id: input.variantId }, include: VARIANT_INCLUDE });
  if (!variant) throw notFound('Variant not found.');

  const before = variant.stock;
  const after = input.mode === 'add' ? before + input.quantity : input.mode === 'remove' ? before - input.quantity : input.quantity;
  if (after < 0) throw badRequest('This would take stock below zero.', [{ path: 'quantity', message: 'Not enough stock to remove.' }]);
  if (after > MAX_STOCK_PER_VARIANT) throw badRequest(`Stock cannot exceed ${MAX_STOCK_PER_VARIANT.toLocaleString('en-US')}.`, [{ path: 'quantity', message: 'Too high.' }]);
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
        actor,
      },
    });
  });
  // M-I5: alert the owner when this move crosses the variant down through the threshold.
  void emitLowStockIfCrossed(input.variantId, before, after);
  return toStockAdjustment(adjustment);
}
