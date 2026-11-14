import { z } from 'zod';

export const itemGroupInputSchema = z.object({
  nameEn: z.string().min(1).max(120),
  nameHi: z.string().max(120).default(''),
  slug: z.string().min(1).max(80).regex(/^[a-z0-9-]+$/, 'Slug: lowercase, numbers and hyphens only.'),
  position: z.number().int().default(100),
  isActive: z.boolean().default(true),
  imageId: z.string().nullable().optional(),
});
export type ItemGroupInput = z.infer<typeof itemGroupInputSchema>;
