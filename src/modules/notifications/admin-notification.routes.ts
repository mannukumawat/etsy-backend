// Mount: app.use('/api/admin/notifications', adminNotificationsRouter)

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { route } from '../../shared/http/async-route.js';
import { cursorSchema, sendNotificationSchema } from './notification.schema.js';
import {
  getOwnerUnreadCount,
  listNotificationSends,
  listOwnerNotifications,
  markAllOwnerNotificationsRead,
  markOwnerNotificationRead,
  sendAdminNotification,
} from './notification.service.js';
import { flushPendingPush, validateCronSecret } from './push.worker.js';

export const adminNotificationsRouter = Router();

// requireOwner is applied globally to /api/admin/* routes in app.ts — no need to repeat here.

/** Rate-limit the send endpoint: max 10 sends per minute per IP. */
const sendLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Too many notifications sent. Try again in a minute.' } },
});

// --- Owner inbox ---

adminNotificationsRouter.get(
  '/',
  route(async (req, res) => {
    const { cursor, limit } = cursorSchema.parse(req.query);
    res.json(await listOwnerNotifications(cursor, limit));
  }),
);

adminNotificationsRouter.get(
  '/unread-count',
  route(async (_req, res) => {
    res.json(await getOwnerUnreadCount());
  }),
);

adminNotificationsRouter.patch(
  '/:id/read',
  route(async (req, res) => {
    await markOwnerNotificationRead(req.params.id);
    res.json({ ok: true });
  }),
);

adminNotificationsRouter.post(
  '/read-all',
  route(async (_req, res) => {
    await markAllOwnerNotificationsRead();
    res.json({ ok: true });
  }),
);

// --- Composer / sends ---

adminNotificationsRouter.post(
  '/send',
  sendLimiter,
  route(async (req, res) => {
    const input = sendNotificationSchema.parse(req.body);
    const result = await sendAdminNotification(input);
    res.json(result);
  }),
);

adminNotificationsRouter.get(
  '/sends',
  route(async (_req, res) => {
    res.json(await listNotificationSends());
  }),
);

// --- Vercel Cron endpoint ---
// Called by Vercel Cron scheduler (Authorization: Bearer $CRON_SECRET).
// Also works fine in a VPS deploy (just not called — push worker runs on interval instead).
adminNotificationsRouter.post(
  '/push-flush',
  route(async (req, res) => {
    if (!validateCronSecret(req.header('authorization'))) {
      res.status(404).json({ error: { code: 'not_found', message: 'Not found.' } });
      return;
    }
    const result = await flushPendingPush();
    res.json(result);
  }),
);
