import { z } from 'zod';

export const SUPPORTED_UI_LANGS = ['en', 'de', 'fr', 'it', 'es', 'en-US', 'en-GB', 'en-IN'] as const;
export type SupportedUiLang = (typeof SUPPORTED_UI_LANGS)[number];

export const isSupportedUiLang = (v: unknown): v is SupportedUiLang =>
  typeof v === 'string' && (SUPPORTED_UI_LANGS as readonly string[]).includes(v);

export const replaceOverridesSchema = z.object({
  overrides: z.record(z.unknown()),
});

export const setOverrideSchema = z.object({
  key: z.string().trim().min(1),
  value: z.string(),
});
