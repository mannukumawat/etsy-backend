import { z } from 'zod';

/** Optional free text: trimmed, empty string stored as null. Ownership, eligibility, order and
 *  moderation status are never accepted from the client — `.strict()` rejects any such extra key. */
const optionalText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, `${label} must be ${max} characters or fewer.`)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));

export const reviewInputSchema = z
  .object({
    rating: z.number({ invalid_type_error: 'Choose a rating from 1 to 5.' }).int('Choose a whole-star rating.').min(1, 'Choose a rating from 1 to 5.').max(5, 'Choose a rating from 1 to 5.'),
    title: optionalText(120, 'Title'),
    body: optionalText(2000, 'Review'),
    photos: z.array(z.string().min(1)).max(5, 'Maximum 5 photos per review.').optional().default([]),
  })
  .strict();

export type ReviewInput = z.infer<typeof reviewInputSchema>;

export const reviewCreateSchema = reviewInputSchema.extend({ productId: z.string().min(1) }).strict();
export type ReviewCreateInput = z.infer<typeof reviewCreateSchema>;

export const reviewModerationSchema = z.object({
  reason: z.string().trim().min(3, 'Give a short reason (at least 3 characters).').max(500),
});
