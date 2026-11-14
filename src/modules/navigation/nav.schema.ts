import { z } from 'zod';
import { isSiteLinkOrFullUrl } from '../../shared/validation/common.schema.js';

export const navLinkInputSchema = z.object({
  labelEn: z.string().trim().min(1, 'Label is required.').max(40),
  labelHi: z.string().trim().max(40).default(''),
  href: z
    .string()
    .trim()
    .min(1, 'Link is required.')
    .max(200)
    .refine(isSiteLinkOrFullUrl, 'Use a site path like /collection/wedding-guide or a full https:// URL.'),
  isActive: z.boolean().default(true),
  position: z.number().int().min(0).max(1000).default(0),
});
export type NavLinkInput = z.infer<typeof navLinkInputSchema>;
