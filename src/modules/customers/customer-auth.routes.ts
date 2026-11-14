import { Router } from 'express';
import { env } from '../../shared/config/env.js';
import { prisma } from '../../shared/database/prisma.js';
import { notFound, unauthorized } from '../../shared/errors/http-error.js';
import { route } from '../../shared/http/async-route.js';
import { requireCustomer } from '../../shared/middleware/customer-auth.middleware.js';
import {
  loginAccountLimiter,
  loginIpLimiter,
  passwordResetAccountLimiter,
  passwordResetConfirmLimiter,
  passwordResetIpLimiter,
  registerLimiter,
} from '../../shared/middleware/rate-limit.middleware.js';
import {
  clearCustomerSession,
  confirmPasswordReset,
  hasPendingPasswordReset,
  issueCustomerSession,
  registerCustomer,
  requestPasswordReset,
  verifyCustomerCredentials,
} from './customer-auth.service.js';
import { toCustomerPublic } from './customer.mapper.js';
import { customerLoginSchema, customerRegisterSchema, passwordResetConfirmSchema, passwordResetRequestSchema } from './customer.schema.js';

// Customer-facing auth (public). Independent of owner auth (modules/admin-auth) — a separate cookie, a
// separate account table, no interaction between the two.

export const customerAuthRouter = Router();

customerAuthRouter.post(
  '/register',
  registerLimiter,
  route(async (req, res) => {
    const input = customerRegisterSchema.parse(req.body);
    const customer = await registerCustomer(input);
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
    await requestPasswordReset(email);
    res.json({ ok: true });
  }),
);

customerAuthRouter.post(
  '/password-reset/confirm',
  passwordResetConfirmLimiter,
  route(async (req, res) => {
    const { token, password } = passwordResetConfirmSchema.parse(req.body);
    await confirmPasswordReset(token, password);
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
    const hasPendingReset = await hasPendingPasswordReset(email);
    if (hasPendingReset === null) return res.json({ resetUrl: null });
    res.json({ hasPendingReset });
  }),
);
