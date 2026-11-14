import { Router } from 'express';
import { prisma } from '../../shared/database/prisma.js';
import { route } from '../../shared/http/async-route.js';
import { requireCustomer } from '../../shared/middleware/customer-auth.middleware.js';
import { toCustomerPublic } from './customer.mapper.js';
import { customerAddressSchema, customerProfileSchema, wishlistToggleSchema } from './customer.schema.js';
import {
  deleteCustomerAddress,
  getCustomerOrder,
  listCustomerAddresses,
  listCustomerOrders,
  listCustomerWishlist,
  removeWishlistProduct,
  saveCustomerAddress,
  toggleWishlistItem,
  updateCustomerProfile,
} from './customer.service.js';

// Profile, addresses, wishlist and order history of the signed-in customer (requireCustomer). Sign-up,
// sign-in and password reset live in customer-auth.routes.ts.

export const customerRouter = Router();

customerRouter.use(requireCustomer);

// --- profile --------------------------------------------------------------------------------------

customerRouter.get('/profile', async (req, res, next) => {
  try {
    const customer = await prisma.customer.findUniqueOrThrow({ where: { id: req.customer!.sub } });
    res.json({ customer: toCustomerPublic(customer) });
  } catch (e) {
    next(e);
  }
});

customerRouter.put(
  '/profile',
  route(async (req, res) => {
    const input = customerProfileSchema.parse(req.body);
    const customer = await updateCustomerProfile(req.customer!.sub, input);
    res.json({ customer: toCustomerPublic(customer) });
  }),
);

// --- addresses ------------------------------------------------------------------------------------

customerRouter.get(
  '/addresses',
  route(async (req, res) => {
    res.json({ items: await listCustomerAddresses(req.customer!.sub) });
  }),
);

customerRouter.put(
  '/addresses',
  route(async (req, res) => {
    const id = typeof req.body?.id === 'string' ? req.body.id : undefined;
    const input = customerAddressSchema.parse(req.body);
    res.json({ items: await saveCustomerAddress(req.customer!.sub, id, input) });
  }),
);

customerRouter.delete(
  '/addresses/:id',
  route(async (req, res) => {
    res.json({ items: await deleteCustomerAddress(req.customer!.sub, req.params.id) });
  }),
);

// --- wishlist -------------------------------------------------------------------------------------

customerRouter.get(
  '/wishlist',
  route(async (req, res) => {
    res.json({ items: await listCustomerWishlist(req.customer!.sub) });
  }),
);

customerRouter.post(
  '/wishlist/toggle',
  route(async (req, res) => {
    const { productId, variantId } = wishlistToggleSchema.parse(req.body);
    res.json(await toggleWishlistItem(req.customer!.sub, productId, variantId));
  }),
);

customerRouter.delete(
  '/wishlist/:productId',
  route(async (req, res) => {
    res.json({ items: await removeWishlistProduct(req.customer!.sub, req.params.productId) });
  }),
);

// --- account deletion (soft delete only — data is never purged) -----------------------------------

customerRouter.delete(
  '/account',
  route(async (req, res) => {
    const scheduledAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000); // 14 days grace
    await prisma.customer.update({
      where: { id: req.customer!.sub },
      data: { deletedAt: scheduledAt },
    });
    res.json({ ok: true });
  }),
);

// --- order history (private: only the signed-in customer's own orders) ---------------------------

customerRouter.get(
  '/orders',
  route(async (req, res) => {
    res.json({ items: await listCustomerOrders(req.customer!.sub) });
  }),
);

customerRouter.get(
  '/orders/:id',
  route(async (req, res) => {
    res.json(await getCustomerOrder(req.customer!.sub, req.params.id));
  }),
);
