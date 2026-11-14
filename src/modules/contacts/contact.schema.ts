import { z } from 'zod';

const CONTACT_SUBJECTS = ['order', 'product', 'custom', 'other'] as const;
export const CONTACT_STATUSES = ['unread', 'read', 'replied'] as const;

/** Public "contact us" form submission. */
export const contactBodySchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().email(),
  subject: z.enum(CONTACT_SUBJECTS),
  orderNumber: z.string().trim().max(30).default(''),
  message: z.string().trim().min(10).max(1000),
});
export type ContactInput = z.infer<typeof contactBodySchema>;

/** Owner triage of a stored message. */
export const contactUpdateSchema = z.object({
  status: z.enum(CONTACT_STATUSES).optional(),
  note: z.string().max(2000).nullable().optional(),
});
export type ContactUpdateInput = z.infer<typeof contactUpdateSchema>;
