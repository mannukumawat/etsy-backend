import { Router } from 'express';
import { route } from '../../shared/http/async-route.js';
import { productInputSchema, statusSchema } from './product.schema.js';
import { assertProductExists, changeProductStatus, createProduct, deleteAllProducts, getProductById, listProducts, updateProduct } from './product.service.js';

export const productRouter = Router();

productRouter.get(
  '/',
  route(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const status = String(req.query.status ?? '').trim();
    const itemGroup = String(req.query.itemGroup ?? '').trim();
    const result = await listProducts({ q, status, itemGroup });
    res.json(result);
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

/** Status-only change (publish / unpublish / archive) without resubmitting the whole product. */
productRouter.patch(
  '/:id/status',
  route(async (req, res) => {
    const { status } = statusSchema.parse(req.body);
    const product = await changeProductStatus(req.params.id, status);
    res.json(product);
  }),
);

/** Delete every product and its children (options, values, variants, images, specs) in one shot. */
productRouter.delete(
  '/all',
  route(async (_req, res) => {
    await deleteAllProducts();
    res.json({ ok: true });
  }),
);
