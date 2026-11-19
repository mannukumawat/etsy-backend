// Mount path: /api/admin/wallet
// All routes require requireOwner middleware (applied in app.ts or here).

import { Router } from 'express';
import { route } from '../../shared/http/async-route.js';
import { requireOwner } from '../../shared/middleware/auth.middleware.js';
import { getBalance, listTransactions } from './wallet.service.js';
import { walletTxListSchema } from './wallet.schema.js';
import { prisma } from '../../shared/database/prisma.js';

export const adminWalletRouter = Router();
adminWalletRouter.use(requireOwner);

/** GET /api/admin/wallet/customers/:customerId — customer wallet balance + transaction history */
adminWalletRouter.get(
  '/customers/:customerId',
  route(async (req, res) => {
    const { customerId } = req.params;
    const { page, pageSize } = walletTxListSchema.parse(req.query);

    const [balancePaise, txResult] = await Promise.all([
      getBalance(customerId),
      listTransactions(customerId, page, pageSize),
    ]);

    res.json({
      customerId,
      balancePaise,
      transactions: txResult,
    });
  }),
);

/** GET /api/admin/wallet/topups/:customerId — customer top-up history */
adminWalletRouter.get(
  '/topups/:customerId',
  route(async (req, res) => {
    const { customerId } = req.params;
    const { page, pageSize } = walletTxListSchema.parse(req.query);

    const [items, total] = await Promise.all([
      prisma.walletTopup.findMany({
        where: { customerId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          amountPaise: true,
          razorpayOrderId: true,
          razorpayPaymentId: true,
          status: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prisma.walletTopup.count({ where: { customerId } }),
    ]);

    res.json({
      items,
      total,
      page,
      pageSize,
      pageCount: Math.max(1, Math.ceil(total / pageSize)),
    });
  }),
);
