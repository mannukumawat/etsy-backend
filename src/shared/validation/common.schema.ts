import { z } from 'zod';

// Server-side rules. The apps validate too, for fast feedback, but these are the authoritative ones:
// a client can be edited, so prices, stock, slugs and SKUs are all re-checked here.

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const localized = (maxLen = 5000, requireEn = false) =>
  z.object({
    en: requireEn ? z.string().trim().min(1, 'English text is required.').max(maxLen) : z.string().trim().max(maxLen).default(''),
    hi: z.string().trim().max(maxLen).default(''),
  });

export const isSiteLinkOrFullUrl = (href: string) => href.startsWith('/') || /^https?:\/\//i.test(href);
