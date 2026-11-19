// Mount: app.use('/api/customer/notifications', customerNotificationsRouter)

import { Router } from 'express';
import { route } from '../../shared/http/async-route.js';
import { requireCustomer } from '../../shared/middleware/customer-auth.middleware.js';
import { cursorSchema, registerTokenSchema } from './notification.schema.js';
import {
  deleteFcmToken,
  getCustomerUnreadCount,
  listCustomerNotifications,
  markAllCustomerNotificationsRead,
  markCustomerNotificationRead,
  upsertFcmToken,
} from './notification.service.js';

export const customerNotificationsRouter = Router();
customerNotificationsRouter.use(requireCustomer);

/** Register or refresh an FCM device token. */
customerNotificationsRouter.post(
  '/token',
  route(async (req, res) => {
    const { token } = registerTokenSchema.parse(req.body);
    await upsertFcmToken(req.customer!.sub, token);
    res.json({ ok: true });
  }),
);

/** Remove a device token (called on logout). */
customerNotificationsRouter.delete(
  '/token',
  route(async (req, res) => {
    const { token } = registerTokenSchema.parse(req.body);
    await deleteFcmToken(token, req.customer!.sub);
    res.json({ ok: true });
  }),
);

/** Paginated inbox. */
customerNotificationsRouter.get(
  '/',
  route(async (req, res) => {
    const { cursor, limit } = cursorSchema.parse(req.query);
    res.json(await listCustomerNotifications(req.customer!.sub, cursor, limit));
  }),
);

/** Unread count badge. */
customerNotificationsRouter.get(
  '/unread-count',
  route(async (req, res) => {
    res.json(await getCustomerUnreadCount(req.customer!.sub));
  }),
);

/** Mark one notification as read. */
customerNotificationsRouter.patch(
  '/:id/read',
  route(async (req, res) => {
    await markCustomerNotificationRead(req.params.id, req.customer!.sub);
    res.json({ ok: true });
  }),
);

/** Mark all as read. */
customerNotificationsRouter.post(
  '/read-all',
  route(async (req, res) => {
    await markAllCustomerNotificationsRead(req.customer!.sub);
    res.json({ ok: true });
  }),
);
