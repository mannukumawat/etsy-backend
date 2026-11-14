import { z } from 'zod';
import { localized, SLUG_RE } from '../../shared/validation/common.schema.js';

export const categoryInputSchema = z.object({
  slug: z.string().trim().regex(SLUG_RE, 'Use lowercase letters, numbers and single hyphens.'),
  name: localized(60, true),
  description: localized(300),
  imageId: z.string().nullable().default(null),
  bannerId: z.string().nullable().default(null),
  displayOrder: z.number().int().min(0).max(100000).default(0),
  isActive: z.boolean().default(true),
});

export type CategoryInput = z.infer<typeof categoryInputSchema>;
