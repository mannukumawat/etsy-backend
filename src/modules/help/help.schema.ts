import { z } from 'zod';

export const helpCategoryInputSchema = z.object({
  slug: z.string().trim().min(1).max(100).regex(/^[a-z0-9-]+$/, 'Slug: lowercase letters, digits and hyphens only'),
  nameEn: z.string().trim().min(1).max(200),
  nameHi: z.string().trim().max(200).default(''),
  descriptionEn: z.string().trim().max(1000).nullable().default(null),
  descriptionHi: z.string().trim().max(1000).nullable().default(null),
  icon: z.string().trim().max(50).default('help-circle'),
  position: z.number().int().default(0),
  isActive: z.boolean().default(true),
});
export type HelpCategoryInput = z.infer<typeof helpCategoryInputSchema>;

export const helpArticleInputSchema = z.object({
  slug: z.string().trim().min(1).max(150).regex(/^[a-z0-9-]+$/, 'Slug: lowercase letters, digits and hyphens only'),
  titleEn: z.string().trim().min(1).max(300),
  titleHi: z.string().trim().max(300).default(''),
  bodyEn: z.string().trim().min(1),
  bodyHi: z.string().trim().default(''),
  position: z.number().int().default(0),
  isActive: z.boolean().default(true),
});
export type HelpArticleInput = z.infer<typeof helpArticleInputSchema>;
