// Mount path: /api/customer/wallet
// All routes require requireCustomer middleware (applied in app.ts or here).
// Webhook route is in webhook.handler.ts — mount at /api/webhooks/wallet/razorpay BEFORE requireCsrf.

import { Router } from 'express';
import { route } from '../../shared/http/async-route.js';
import { requireCustomer } from '../../shared/middleware/customer-auth.middleware.js';
import { topupLimiter } from '../../shared/middleware/rate-limit.middleware.js';
import { getBalance, listTransactions } from './wallet.service.js';
import { initiateTopup, verifyTopup } from './wallet-topup.service.js';
import { createTopupSchema, verifyTopupSchema, walletTxListSchema } from './wallet.schema.js';
import { isWalletTopupEnabled } from '../../shared/config/env.js';

// H12: the top-up money endpoints are rate-limited by `topupLimiter` from the shared
// rate-limit middleware.

export const walletRouter = Router();
walletRouter.use(requireCustomer);

/** GET /api/customer/wallet — current balance */
walletRouter.get(
  '/',
  route(async (req, res) => {
    const customerId = req.customer!.sub;
    const balancePaise = await getBalance(customerId);
    res.json({ balancePaise, topupEnabled: isWalletTopupEnabled });
  }),
);

/** GET /api/customer/wallet/transactions — paginated ledger */
walletRouter.get(
  '/transactions',
  route(async (req, res) => {
    const customerId = req.customer!.sub;
    const { page, pageSize } = walletTxListSchema.parse(req.query);
    const result = await listTransactions(customerId, page, pageSize);
    res.json(result);
  }),
);

/** POST /api/customer/wallet/topup/create — initiate a Razorpay top-up */
walletRouter.post(
  '/topup/create',
  topupLimiter,
  route(async (req, res) => {
    const customerId = req.customer!.sub;
    const input = createTopupSchema.parse(req.body);
    const result = await initiateTopup(customerId, input);
    res.status(201).json(result);
  }),
);

/** POST /api/customer/wallet/topup/verify — verify payment and credit wallet */
walletRouter.post(
  '/topup/verify',
  topupLimiter,
  route(async (req, res) => {
    const customerId = req.customer!.sub;
    const input = verifyTopupSchema.parse(req.body);
    const result = await verifyTopup(customerId, input);
    res.json(result);
  }),
);
