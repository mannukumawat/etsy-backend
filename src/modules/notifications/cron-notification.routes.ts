import { Router } from 'express';
import { route } from '../../shared/http/async-route.js';
import { flushPendingPush, validateCronSecret } from './push.worker.js';
import { unauthorized } from '../../shared/errors/http-error.js';

export const cronNotificationsRouter = Router();

cronNotificationsRouter.get('/push-flush', route(async (req, res) => {
  if (!validateCronSecret(req.headers.authorization)) {
    throw unauthorized('Invalid or missing CRON_SECRET.');
  }
  const result = await flushPendingPush();
  res.json({ ok: true, processed: result.processed });
}));
