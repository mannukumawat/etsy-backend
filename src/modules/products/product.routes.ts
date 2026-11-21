import { Router } from 'express';
import { route } from '../../shared/http/async-route.js';
import { parsePage, parsePageSize } from '../../shared/utils/pagination.js';
import { productInputSchema, statusSchema } from './product.schema.js';
import { assertProductExists, changeProductStatus, checkProductAvailability, createProduct, deleteAllProducts, duplicateProduct, getProductById, listProducts, updateProduct } from './product.service.js';
import type { ProductListQuery } from './product.types.js';

export const productRouter = Router();

/** Shared query parsing for the list, export and Delete All (H16/H7): one parser, one meaning. */
export function parseProductListQuery(query: Record<string, unknown>): ProductListQuery {
  return {
    q: String(query.q ?? '').trim(),
    status: String(query.status ?? '').trim(),
    category: String(query.category ?? '').trim(),
    stock: String(query.stock ?? '').trim(),
    flag: String(query.flag ?? '').trim(),
    sort: String(query.sort ?? 'updated').trim(),
    dir: query.dir === 'asc' ? 'asc' : 'desc',
    itemGroup: String(query.itemGroup ?? '').trim(),
    page: parsePage(query.page),
    pageSize: parsePageSize(query.pageSize),
  };
}

productRouter.get(
  '/',
  route(async (req, res) => {
    const result = await listProducts(parseProductListQuery(req.query as Record<string, unknown>));
    res.json(result);
  }),
);

/**
 * GET /check-availability — the editor's server-side slug/SKU uniqueness check (H16).
 * Must sit ABOVE `/:id`: otherwise `id = 'check-availability'` 404s (the C1 trap).
 */
productRouter.get(
  '/check-availability',
  route(async (req, res) => {
    const slug = String(req.query.slug ?? '').trim();
    const skus = String(req.query.skus ?? '')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    const excludeId = String(req.query.excludeId ?? '').trim() || null;
    res.json(await checkProductAvailability({ slug, skus, excludeId }));
  }),
);

productRouter.get(
  '/:id',
  route(async (req, res) => {
    const product = await getProductById(req.params.id);
    res.json(product);
  }),
);

productRouter.post(
  '/',
  route(async (req, res) => {
    const input = productInputSchema.parse(req.body);
    const product = await createProduct(input);
    res.status(201).json(product);
  }),
);

productRouter.put(
  '/:id',
  route(async (req, res) => {
    // An unknown id answers 404 before the body is validated (400), as this endpoint always has.
    await assertProductExists(req.params.id);
    const input = productInputSchema.parse(req.body);
    const product = await updateProduct(req.params.id, input);
    res.json(product);
  }),
);

/** POST /:id/duplicate — a real server-side copy (H17), draft with zero stock. */
productRouter.post(
  '/:id/duplicate',
  route(async (req, res) => {
    const product = await duplicateProduct(req.params.id);
    res.status(201).json(product);
  }),
);

/** Status-only change (publish / unpublish / archive) without resubmitting the whole product. */
productRouter.patch(
  '/:id/status',
  route(async (req, res) => {
    const { status } = statusSchema.parse(req.body);
    const product = await changeProductStatus(req.params.id, status);
    res.json(product);
  }),
);

/**
 * Delete products in one shot. With list filters in the query string only the FILTERED
 * set is deleted (H7); without filters, the whole catalogue. Always recorded in the
 * audit log. Media files and inventory history are kept (see product.service).
 */
productRouter.delete(
  '/all',
  route(async (req, res) => {
    const query = parseProductListQuery(req.query as Record<string, unknown>);
    const hasFilters = Boolean(query.q || query.status || query.category || query.stock || query.flag || query.itemGroup);
    const { deleted } = await deleteAllProducts(req.owner!.email, hasFilters ? query : undefined);
    res.json({ ok: true, deleted });
  }),
);
