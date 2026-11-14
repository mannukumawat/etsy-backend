import { z } from 'zod';
import { localized } from '../../shared/validation/common.schema.js';

export const mediaUploadSchema = z.object({
  fileName: z.string().trim().min(1).max(200),
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml']),
  /** Raw base64 (no data: prefix). ~5 MB decoded ceiling. */
  base64: z.string().min(1).max(7_500_000),
  width: z.number().int().positive().nullable().default(null),
  height: z.number().int().positive().nullable().default(null),
  alt: localized(200),
});

export type MediaUploadInput = z.infer<typeof mediaUploadSchema>;

export const mediaUrlImportSchema = z.object({
  url: z.string().trim().url('Enter a valid image URL.').refine((value) => /^https?:\/\//i.test(value), 'Use an http:// or https:// image URL.'),
  alt: localized(200),
});
export type MediaUrlImportInput = z.infer<typeof mediaUrlImportSchema>;
