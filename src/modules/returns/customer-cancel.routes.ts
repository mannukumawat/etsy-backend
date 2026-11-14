import { Router } from 'express';
import { route } from '../../shared/http/async-route.js';
import { requireCustomer } from '../../shared/middleware/customer-auth.middleware.js';
import { cancelOrderLine } from './line-cancellation.service.js';
import { cancelLineSchema } from './return.schema.js';

// Item cancellation, mounted at /api/customer/orders. Requires an authenticated customer session.

export const customerCancelRouter = Router();
customerCancelRouter.use(requireCustomer);

customerCancelRouter.post(
  '/:orderId/lines/:lineId/cancel',
  route(async (req, res) => {
    const input = cancelLineSchema.parse(req.body);
    const { orderId, lineId } = req.params;
    const { cancelledQty, allCancelled, orderCancelled } = await cancelOrderLine(req.customer!.sub, orderId, lineId, input);
    res.json({ ok: true, cancelledQty, allCancelled, orderCancelled });
  }),
);
