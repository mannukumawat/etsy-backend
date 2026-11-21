import { z } from 'zod';

/** Public newsletter signup — footer form. Email is lower-cased and validated; a repeat
 *  signup for the same email succeeds silently (see newsletter.service.ts). */
export const newsletterSubscribeSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(200),
});
export type NewsletterSubscribeInput = z.infer<typeof newsletterSubscribeSchema>;
