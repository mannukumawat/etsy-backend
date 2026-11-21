// Owner view over paid-but-no-order payments (H5): list unmatched recoveries and mark
// them resolved once the order has been created manually or the payment refunded.
import { Router } from 'express';
import { z } from 'zod';
import { route } from '../../shared/http/async-route.js';
import { requireOwner } from '../../shared/middleware/auth.middleware.js';
import { listPaymentRecoveries, resolvePaymentRecovery } from '../checkout/payment-recovery.service.js';

export const paymentRecoveryRouter = Router();
paymentRecoveryRouter.use(requireOwner);

paymentRecoveryRouter.get(
  '/',
  route(async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const rows = await listPaymentRecoveries(status);
    res.json({
      items: rows.map((r) => ({
        id: r.id,
        razorpayPaymentId: r.razorpayPaymentId,
        razorpayOrderId: r.razorpayOrderId,
        amount: r.amount,
        currency: r.currency,
        customerEmail: r.customerEmail,
        status: r.status,
        resolutionNote: r.resolutionNote,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      })),
      total: rows.length,
    });
  }),
);

const resolveSchema = z.object({ note: z.string().trim().min(3, 'Say what was done for this payment (order created or refund issued).').max(500) });

paymentRecoveryRouter.post(
  '/:id/resolve',
  route(async (req, res) => {
    const { note } = resolveSchema.parse(req.body);
    const row = await resolvePaymentRecovery(req.params.id, note, req.owner!.email);
    res.json({
      id: row.id,
      razorpayPaymentId: row.razorpayPaymentId,
      razorpayOrderId: row.razorpayOrderId,
      amount: row.amount,
      currency: row.currency,
      customerEmail: row.customerEmail,
      status: row.status,
      resolutionNote: row.resolutionNote,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    });
  }),
);
