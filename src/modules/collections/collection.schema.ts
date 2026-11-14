import { z } from 'zod';
import { isSiteLinkOrFullUrl, SLUG_RE } from '../../shared/validation/common.schema.js';

export const collectionCircleInputSchema = z
  .object({
    labelEn: z.string().trim().min(1, 'Label is required.').max(40),
    labelHi: z.string().trim().max(40).default(''),
    imageId: z.string().nullable().default(null),
    linkType: z.enum(['category', 'collection', 'url']),
    linkValue: z.string().trim().min(1, 'Choose a destination.').max(200),
  })
  .superRefine((c, ctx) => {
    if (c.linkType === 'url' && !isSiteLinkOrFullUrl(c.linkValue)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['linkValue'], message: 'Use a site path or a full https:// URL.' });
    }
  });

export const collectionSectionInputSchema = z.object({
  titleEn: z.string().trim().min(1, 'Section title is required.').max(60),
  titleHi: z.string().trim().max(60).default(''),
  productIds: z.array(z.string().min(1)).max(60).default([]),
});

export const collectionInputSchema = z.object({
  slug: z.string().trim().regex(SLUG_RE, 'Use lowercase letters, numbers and single hyphens.'),
  titleEn: z.string().trim().min(1, 'Title is required.').max(80),
  titleHi: z.string().trim().max(80).default(''),
  subtitleEn: z.string().trim().max(200).default(''),
  subtitleHi: z.string().trim().max(200).default(''),
  descriptionEn: z.string().trim().max(2000).default(''),
  descriptionHi: z.string().trim().max(2000).default(''),
  heroImageId: z.string().nullable().default(null),
  heroColor: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #F5ECE1.')
    .default('#F5ECE1'),
  displayOrder: z.number().int().min(0).max(100000).default(0),
  showInNavigation: z.boolean().default(false),
  circles: z.array(collectionCircleInputSchema).max(12, 'Use at most 12 circles.').default([]),
  sections: z.array(collectionSectionInputSchema).min(1, 'Add at least one product section.').max(10, 'Use at most 10 sections.'),
});
export type CollectionInput = z.infer<typeof collectionInputSchema>;

export const collectionStatusSchema = z.object({ status: z.enum(['draft', 'published']) });
