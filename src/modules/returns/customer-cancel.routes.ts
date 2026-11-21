import { Router } from 'express';
import { route } from '../../shared/http/async-route.js';
import { requireCustomer } from '../../shared/middleware/customer-auth.middleware.js';
import { cancelEntireOrder, cancelOrderLine } from './line-cancellation.service.js';
import { cancelLineSchema, cancelWholeOrderSchema } from './return.schema.js';

// Item cancellation, mounted at /api/customer/orders. Requires an authenticated customer session.

export const customerCancelRouter = Router();
customerCancelRouter.use(requireCustomer);

customerCancelRouter.post(
  '/:orderId/lines/:lineId/cancel',
  route(async (req, res) => {
    const input = cancelLineSchema.parse(req.body);
    const { orderId, lineId } = req.params;
    const result = await cancelOrderLine(req.customer!.sub, orderId, lineId, input);
    res.json({ ok: true, ...result });
  }),
);

/** Whole-order cancellation (C4): cancels every remaining unit through the same
 *  per-line path as a line cancellation, and refunds a paid order for the full
 *  cancelled value. */
customerCancelRouter.post(
  '/:orderId/cancel',
  route(async (req, res) => {
    const input = cancelWholeOrderSchema.parse(req.body ?? {});
    const { orderId } = req.params;
    const result = await cancelEntireOrder(req.customer!.sub, orderId, input.reason);
    res.json({ ok: true, ...result });
  }),
);
