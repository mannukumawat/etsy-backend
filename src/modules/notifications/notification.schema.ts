import { z } from 'zod';

export const registerTokenSchema = z.object({
  token: z.string().min(1, 'FCM token required.'),
});

export const sendNotificationSchema = z.object({
  customerId: z.string().nullable().default(null),
  title: z.string().min(1).max(100),
  body: z.string().min(1).max(300),
  link: z.string().max(500).optional(),
});

export const cursorSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
