// Mount path: /api/admin/wallet
// All routes require requireOwner middleware (applied in app.ts or here).

import { Router } from 'express';
import { route } from '../../shared/http/async-route.js';
import { requireOwner } from '../../shared/middleware/auth.middleware.js';
import { getBalance, listTransactions, creditWallet, debitWallet } from './wallet.service.js';
import { adminWalletAdjustSchema, walletTxListSchema } from './wallet.schema.js';
import { prisma } from '../../shared/database/prisma.js';
import { recordAuditLog } from '../../shared/utils/audit-log.js';
import { randomHexId } from '../../shared/utils/ids.js';

export const adminWalletRouter = Router();
adminWalletRouter.use(requireOwner);

/** GET /api/admin/wallet/customers/:customerId — customer wallet balance + transaction history */
adminWalletRouter.get(
  '/customers/:customerId',
  route(async (req, res) => {
    const { customerId } = req.params;
    const { page, pageSize } = walletTxListSchema.parse(req.query);

    const [balanceMinor, txResult] = await Promise.all([
      getBalance(customerId),
      listTransactions(customerId, page, pageSize),
    ]);

    res.json({
      customerId,
      balanceMinor,
      transactions: txResult,
    });
  }),
);

/** POST /api/admin/wallet/customers/:customerId/adjust — owner credit/debit with a reason (M-O7).
 *  Recorded as a `reversal` ledger row with an `admin-adjust:` reference and an audit-log
 *  entry; the customer sees it in their wallet history like any other transaction. */
adminWalletRouter.post(
  '/customers/:customerId/adjust',
  route(async (req, res) => {
    const { customerId } = req.params;
    const input = adminWalletAdjustSchema.parse(req.body);
    const customer = await prisma.customer.findUnique({ where: { id: customerId }, select: { id: true } });
    if (!customer) return res.status(404).json({ code: 'not_found', message: 'Customer not found.' });
    const reference = `admin-adjust:${randomHexId(8)}`;
    const result =
      input.direction === 'credit'
        ? await creditWallet(customerId, input.amountMinor, 'reversal', reference, { note: input.note })
        : await debitWallet(customerId, input.amountMinor, 'reversal', reference, { note: input.note });
    await recordAuditLog(prisma, {
      actor: req.owner!.email,
      action: `wallet.${input.direction}`,
      targetType: 'customer',
      targetId: customerId,
      detail: `${input.direction === 'credit' ? 'Credited' : 'Debited'} ${input.amountMinor} cents USD (${reference}): ${input.note}`,
    });
    res.json({ customerId, balanceMinor: result.newBalance, txId: result.txId, reference });
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
          amountMinor: true,
          currency: true,
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
