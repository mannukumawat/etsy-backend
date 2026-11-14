import { z } from 'zod';
import { localized } from '../../shared/validation/common.schema.js';

const isSiteLinkOrUrl = (href: string) => href === '' || href.startsWith('/') || /^https?:\/\//i.test(href);

const idList = (max: number) =>
  z
    .array(z.string().min(1))
    .max(max, `Choose at most ${max}.`)
    .default([])
    .refine((arr) => new Set(arr).size === arr.length, 'The same item is listed twice.');

export const homepageContentSchema = z
  .object({
    announcement: z.object({ enabled: z.boolean().default(false), text: localized(140) }),
    hero: z.object({
      title: localized(120, true),
      subtitle: localized(240),
      imageId: z.string().nullable().default(null),
      ctaLabel: localized(40, true),
      ctaHref: z.string().trim().default(''),
    }),
    /** Extra banners shown after the hero in the homepage slider. */
    slides: z
      .array(
        z.object({
          id: z.string().min(1),
          imageId: z.string().nullable().default(null),
          title: localized(120),
          subtitle: localized(240),
          ctaLabel: localized(40),
          ctaHref: z.string().trim().default(''),
        }),
      )
      .max(6, 'Use at most 6 slider banners.')
      .default([]),
    featuredCategoryIds: z.array(z.string().min(1)).max(50).default([]),
    featuredProductIds: idList(12),
    bestsellerProductIds: idList(12),
    newArrivalProductIds: idList(12),
    itemsProductIds: idList(12),
    transferProductIds: idList(12),
    story: z.object({
      title: localized(120, true),
      body: localized(2000),
      imageId: z.string().nullable().default(null),
      ctaLabel: localized(40),
      ctaHref: z.string().trim().default(''),
    }),
    newsletter: z.object({ title: localized(120, true), body: localized(300) }),
  })
  .superRefine((c, ctx) => {
    const add = (path: (string | number)[], message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
    if (c.announcement.enabled && !c.announcement.text.en.trim()) add(['announcement', 'text', 'en'], 'Announcement text is required while the bar is enabled.');
    if (!isSiteLinkOrUrl(c.hero.ctaHref)) add(['hero', 'ctaHref'], 'Use a site path like /shop or a full https:// URL.');
    c.slides.forEach((sl, i) => {
      if (!sl.imageId) add(['slides', i, 'imageId'], 'Choose an image for this banner.');
      if (!isSiteLinkOrUrl(sl.ctaHref)) add(['slides', i, 'ctaHref'], 'Use a site path like /shop or a full https:// URL.');
    });
    if (c.story.ctaHref && !isSiteLinkOrUrl(c.story.ctaHref)) add(['story', 'ctaHref'], 'Use a site path like /about or a full https:// URL.');
  });
export type HomepageContentInput = z.infer<typeof homepageContentSchema>;

export const pageContentSchema = z.object({
  title: localized(100, true),
  intro: localized(500),
  /** Optional banner image (used by the About page). */
  heroImageId: z.string().nullable().default(null),
  sections: z
    .array(z.object({ id: z.string().min(1), heading: localized(100, true), body: localized(3000, true), imageId: z.string().nullable().default(null) }))
    .max(30, 'Use at most 30 sections.')
    .default([]),
});
export type PageContentInput = z.infer<typeof pageContentSchema>;

export const PAGE_KEYS = ['about', 'contact', 'faq', 'shipping', 'returns', 'privacy', 'terms'] as const;
export type PageKey = (typeof PAGE_KEYS)[number];
