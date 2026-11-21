import { Router } from 'express';
import { route } from '../../shared/http/async-route.js';
import { newsletterLimiter } from '../../shared/middleware/rate-limit.middleware.js';
import { newsletterSubscribeSchema } from './newsletter.schema.js';
import { subscribeToNewsletter, unsubscribeFromNewsletter } from './newsletter.service.js';

export const newsletterRouter = Router();

newsletterRouter.post(
  '/newsletter',
  newsletterLimiter,
  route(async (req, res) => {
    // schema.parse throws → the standard error handler formats it as
    // { error: { code: 'validation', issues: [{ path, message }] } }.
    const body = newsletterSubscribeSchema.parse(req.body);
    const result = await subscribeToNewsletter(body);
    res.json(result);
  }),
);

newsletterRouter.post(
  '/newsletter/unsubscribe',
  newsletterLimiter,
  route(async (req, res) => {
    const body = newsletterSubscribeSchema.parse(req.body);
    const result = await unsubscribeFromNewsletter(body);
    res.json(result);
  }),
);
