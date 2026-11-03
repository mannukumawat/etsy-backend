import { createHash, randomBytes } from 'node:crypto';
import { Router } from 'express';
import { clearCustomerSession, hashPassword, issueCustomerSession, requireCustomer, verifyCustomerCredentials } from '../customerAuth.js';
import { prisma } from '../db.js';
import { badRequest, conflict, notFound, route, unauthorized } from '../http.js';
import { ORDER_INCLUDE, toCustomerPublic, toSavedAddress, toStorefrontOrder } from '../mappers.js';
import { env } from '../env.js';
import { sendMail } from '../mailer.js';
import {
  loginAccountLimiter,
  loginIpLimiter,
  passwordResetAccountLimiter,
  passwordResetConfirmLimiter,
  passwordResetIpLimiter,
  registerLimiter,
} from '../rateLimit.js';
import {
  customerAddressSchema,
  customerLoginSchema,
  customerProfileSchema,
  customerRegisterSchema,
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
  wishlistToggleSchema,
} from '../validation.js';

// Customer-facing auth (public), profile/addresses/wishlist (requireCustomer). Independent of owner
// auth (auth.ts) — a separate cookie, a separate account table, no interaction between the two.

export const customerAuthRouter = Router();
export const customerRouter = Router();

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const hashToken = (raw: string) => createHash('sha256').update(raw).digest('hex');

// --- auth -----------------------------------------------------------------------------------------

customerAuthRouter.post(
  '/register',
  registerLimiter,
  route(async (req, res) => {
    const input = customerRegisterSchema.parse(req.body);
    const email = input.email.trim().toLowerCase();
    const existing = await prisma.customer.findUnique({ where: { email } });
    if (existing) throw conflict('An account with this email already exists.', [{ path: 'email', message: 'Already registered.' }]);
    const customer = await prisma.customer.create({
      data: { name: input.name.trim(), email, passwordHash: await hashPassword(input.password) },
    });
    issueCustomerSession(res, customer);
    res.status(201).json({ customer: toCustomerPublic(customer) });
  }),
);

customerAuthRouter.post(
  '/login',
  loginIpLimiter,
  loginAccountLimiter,
  route(async (req, res) => {
    const { email, password } = customerLoginSchema.parse(req.body);
    const customer = await verifyCustomerCredentials(email, password);
    if (!customer) throw unauthorized('Email or password is incorrect.');
    issueCustomerSession(res, customer);
    res.json({ customer: toCustomerPublic(customer) });
  }),
);

customerAuthRouter.post('/logout', (_req, res) => {
  clearCustomerSession(res);
  res.json({ ok: true });
});

customerAuthRouter.get('/me', requireCustomer, async (req, res, next) => {
  try {
    const customer = await prisma.customer.findUnique({ where: { id: req.customer!.sub } });
    if (!customer) throw unauthorized();
    res.json({ customer: toCustomerPublic(customer) });
  } catch (e) {
    next(e);
  }
});

// Always responds { ok: true } regardless of whether the email exists, so the endpoint cannot be used
// to discover which emails have accounts.
customerAuthRouter.post(
  '/password-reset/request',
  passwordResetIpLimiter,
  passwordResetAccountLimiter,
  route(async (req, res) => {
    const { email } = passwordResetRequestSchema.parse(req.body);
    const customer = await prisma.customer.findUnique({ where: { email: email.trim().toLowerCase() } });
    if (customer) {
      const token = randomBytes(32).toString('hex');
      await prisma.passwordResetToken.create({
        data: { customerId: customer.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS) },
      });
      const resetUrl = `${env.STOREFRONT_PUBLIC_URL.replace(/\/$/, '')}/reset-password?token=${token}`;
      await sendMail(customer.email, 'Reset your password', `Reset your password: ${resetUrl}\n\nThis link expires in 1 hour. If you didn't request this, ignore this email.`);
    }
    res.json({ ok: true });
  }),
);

customerAuthRouter.post(
  '/password-reset/confirm',
  passwordResetConfirmLimiter,
  route(async (req, res) => {
    const { token, password } = passwordResetConfirmSchema.parse(req.body);
    const row = await prisma.passwordResetToken.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!row || row.usedAt || row.expiresAt < new Date()) {
      throw badRequest('This reset link is invalid or has expired. Request a new one.', [{ path: 'token', message: 'Invalid or expired.' }]);
    }
    await prisma.$transaction([
      prisma.customer.update({ where: { id: row.customerId }, data: { passwordHash: await hashPassword(password) } }),
      prisma.passwordResetToken.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
      // Any other outstanding reset links for this account are invalidated by the password change.
      prisma.passwordResetToken.deleteMany({ where: { customerId: row.customerId, id: { not: row.id }, usedAt: null } }),
    ]);
    res.json({ ok: true });
  }),
);

// Development convenience only: with no email provider configured there is nowhere else to see the
// reset link while testing. Returns 404 in production so it can never be used to bypass email.
customerAuthRouter.get(
  '/dev/reset-link',
  route(async (req, res) => {
    if (env.isProd) throw notFound();
    const email = String(req.query.email ?? '').trim().toLowerCase();
    const customer = email ? await prisma.customer.findUnique({ where: { email } }) : null;
    if (!customer) return res.json({ resetUrl: null });
    const row = await prisma.passwordResetToken.findFirst({
      where: { customerId: customer.id, usedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    // The raw token was never stored (only its hash), so this endpoint can only confirm whether a
    // live request exists — it cannot resurrect the link after the fact. Tests should read the link
    // from the server console output, which prints it in full when SMTP is not configured.
    res.json({ hasPendingReset: !!row });
  }),
);

// --- profile / addresses / wishlist (requires a signed-in customer) -------------------------------

customerRouter.use(requireCustomer);

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
    const email = input.email.trim().toLowerCase();
    const other = await prisma.customer.findUnique({ where: { email } });
    if (other && other.id !== req.customer!.sub) throw conflict('An account with this email already exists.', [{ path: 'email', message: 'Already registered.' }]);
    const customer = await prisma.customer.update({ where: { id: req.customer!.sub }, data: { name: input.name.trim(), email, phone: input.phone } });
    res.json({ customer: toCustomerPublic(customer) });
  }),
);

async function listAddresses(customerId: string) {
  const rows = await prisma.customerAddress.findMany({ where: { customerId }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] });
  return rows.map(toSavedAddress);
}

customerRouter.get(
  '/addresses',
  route(async (req, res) => {
    res.json({ items: await listAddresses(req.customer!.sub) });
  }),
);

/** Upsert by id (matches the storefront's `saveAddress(userId, {..., id?})`). The first address, or
 *  any address explicitly marked default, becomes the sole default. */
customerRouter.put(
  '/addresses',
  route(async (req, res) => {
    const id = typeof req.body?.id === 'string' ? req.body.id : undefined;
    const input = customerAddressSchema.parse(req.body);
    const customerId = req.customer!.sub;

    if (id) {
      const existing = await prisma.customerAddress.findUnique({ where: { id } });
      if (!existing || existing.customerId !== customerId) throw notFound('Address not found.');
    }

    await prisma.$transaction(async (tx) => {
      const existingCount = await tx.customerAddress.count({ where: { customerId } });
      const willBeDefault = input.isDefault || existingCount === 0;
      if (willBeDefault) await tx.customerAddress.updateMany({ where: { customerId }, data: { isDefault: false } });

      const data = { ...input, isDefault: willBeDefault, customerId };
      if (id) await tx.customerAddress.update({ where: { id }, data });
      else await tx.customerAddress.create({ data });
    });

    res.json({ items: await listAddresses(customerId) });
  }),
);

customerRouter.delete(
  '/addresses/:id',
  route(async (req, res) => {
    const customerId = req.customer!.sub;
    const existing = await prisma.customerAddress.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.customerId !== customerId) throw notFound('Address not found.');
    await prisma.customerAddress.delete({ where: { id: req.params.id } });
    // Promote another address to default if the deleted one was it, matching the mock's behaviour.
    if (existing.isDefault) {
      const next = await prisma.customerAddress.findFirst({ where: { customerId }, orderBy: { createdAt: 'asc' } });
      if (next) await prisma.customerAddress.update({ where: { id: next.id }, data: { isDefault: true } });
    }
    res.json({ items: await listAddresses(customerId) });
  }),
);

async function listWishlist(customerId: string) {
  const rows = await prisma.wishlistItem.findMany({ where: { customerId }, orderBy: { createdAt: 'desc' } });
  return rows.map((r) => ({ productId: r.productId, variantId: r.variantId ?? undefined, addedAt: r.createdAt.toISOString() }));
}

customerRouter.get(
  '/wishlist',
  route(async (req, res) => {
    res.json({ items: await listWishlist(req.customer!.sub) });
  }),
);

customerRouter.post(
  '/wishlist/toggle',
  route(async (req, res) => {
    const { productId, variantId } = wishlistToggleSchema.parse(req.body);
    const customerId = req.customer!.sub;
    const product = await prisma.product.findUnique({ where: { id: productId }, select: { id: true } });
    if (!product) throw badRequest('Product not found.', [{ path: 'productId', message: 'Not found.' }]);

    const existing = await prisma.wishlistItem.findFirst({ where: { customerId, productId, variantId: variantId ?? null } });
    let saved: boolean;
    if (existing) {
      await prisma.wishlistItem.delete({ where: { id: existing.id } });
      saved = false;
    } else {
      await prisma.wishlistItem.create({ data: { customerId, productId, variantId: variantId ?? null } });
      saved = true;
    }
    res.json({ saved, items: await listWishlist(customerId) });
  }),
);

customerRouter.delete(
  '/wishlist/:productId',
  route(async (req, res) => {
    const customerId = req.customer!.sub;
    await prisma.wishlistItem.deleteMany({ where: { customerId, productId: req.params.productId } });
    res.json({ items: await listWishlist(customerId) });
  }),
);

// --- order history (private: only the signed-in customer's own orders) ---------------------------

customerRouter.get(
  '/orders',
  route(async (req, res) => {
    const rows = await prisma.order.findMany({ where: { customerId: req.customer!.sub }, include: ORDER_INCLUDE, orderBy: { createdAt: 'desc' } });
    res.json({ items: rows.map(toStorefrontOrder) });
  }),
);

customerRouter.get(
  '/orders/:id',
  route(async (req, res) => {
    const row = await prisma.order.findUnique({ where: { id: req.params.id }, include: ORDER_INCLUDE });
    if (!row || row.customerId !== req.customer!.sub) throw notFound('Order not found.');
    res.json(toStorefrontOrder(row));
  }),
);
