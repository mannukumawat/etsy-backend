import { Router } from 'express';
import { route } from '../../shared/http/async-route.js';
import { orderLookupLimiter } from '../../shared/middleware/rate-limit.middleware.js';
import { toStorefrontOrder, toStorefrontOrderTrack } from './order.mapper.js';
import { orderTrackSchema } from './order.schema.js';
import { findOrderByNumberAndEmail, getOrderForViewer } from './order-tracking.service.js';

export const orderTrackRouter = Router();

// --- order tracking / retrieval (public routes, each with its own, deliberately different strength) -
//
//   GET /api/orders/track   - by the human-readable, SEQUENTIAL order number (YS-240501, YS-240502...),
//                             which IS guessable, so it additionally requires the matching email, and
//                             returns a trimmed view (no full address/phone/email) since number+email
//                             is a much weaker proof of ownership than what the full view below needs.
//   GET /api/orders/:id     - the full order, by its unguessable cuid. An account order additionally
//                             requires the signed-in customer to be its owner (the id alone is not
//                             enough — it used to be the only check and was not sufficient; see the
//                             security regression tests). A guest order additionally requires the one-time access
//                             token minted at checkout (see POST /api/checkout/orders), sent as the
//                             X-Order-Token header — never a query string, so it can't end up in a
//                             server log, analytics event, or a Referer header sent to a third party.
//                             Both branches respond with Cache-Control: no-store.

orderTrackRouter.get(
  '/track',
  orderLookupLimiter,
  route(async (req, res) => {
    const input = orderTrackSchema.parse({ number: req.query.number, email: req.query.email });
    const order = await findOrderByNumberAndEmail(input);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(toStorefrontOrderTrack(order));
  }),
);

// Registered BEFORE "/:id" — otherwise Express would match "/track" itself as an :id value.
orderTrackRouter.get(
  '/:id',
  orderLookupLimiter,
  route(async (req, res) => {
    const { order, lineExtras } = await getOrderForViewer(req.params.id, { customerId: req.customer?.sub ?? null, orderToken: req.get('x-order-token') });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(toStorefrontOrder(order, lineExtras));
  }),
);
