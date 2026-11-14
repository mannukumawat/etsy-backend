import { z } from 'zod';

export const CONTENT_LANGS = ['de', 'fr', 'it', 'es'] as const;
export type ContentLang = (typeof CONTENT_LANGS)[number];

export const upsertTranslationSchema = z.object({
  source: z.string().trim().min(1),
  lang: z.enum(CONTENT_LANGS),
  text: z.string().trim().max(20000),
});
export type UpsertTranslationInput = z.infer<typeof upsertTranslationSchema>;
