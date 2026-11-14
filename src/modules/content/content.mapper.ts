import { mediaUrl } from '../../shared/config/env.js';
import { Lopt } from '../../shared/utils/localized.js';

function safeParseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function toAdminHomepage(row: { draftJson: string; publishedJson: string | null; publishedAt: Date | null; updatedAt: Date; updatedBy: string }) {
  return {
    draft: safeParseJson(row.draftJson, null),
    published: row.publishedJson ? safeParseJson(row.publishedJson, null) : null,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
  };
}

export function toAdminPageDoc(row: { key: string; isLegal: boolean; draftJson: string; publishedJson: string | null; publishedAt: Date | null; updatedAt: Date; updatedBy: string }) {
  return {
    key: row.key,
    isLegal: row.isLegal,
    draft: safeParseJson(row.draftJson, null),
    published: row.publishedJson ? safeParseJson(row.publishedJson, null) : null,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
  };
}

/** Recursively turns `{en,hi}` pairs into the storefront's `Localized` (hi omitted when empty), for
 *  arbitrary JSON content stored as admin's always-both-keys shape. */
function toStorefrontLocalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toStorefrontLocalized);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.en === 'string' && typeof obj.hi === 'string' && Object.keys(obj).length === 2) {
      return Lopt(obj.en, obj.hi);
    }
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, toStorefrontLocalized(v)]));
  }
  return value;
}

/** Resolves a hero/story `imageId` to a durable `/media/:id` URL (or null when unset). */
function resolveImage(obj: unknown): unknown {
  if (!obj || typeof obj !== 'object') return obj;
  const o = obj as Record<string, unknown>;
  if ('imageId' in o) {
    const { imageId, ...rest } = o;
    return { ...rest, image: typeof imageId === 'string' ? mediaUrl(imageId) : null };
  }
  return o;
}

export function toStorefrontHomepage(published: Record<string, unknown>) {
  const localized = toStorefrontLocalized(published) as Record<string, unknown>;
  return {
    ...localized,
    hero: resolveImage(localized.hero),
    story: resolveImage(localized.story),
    slides: Array.isArray(localized.slides) ? localized.slides.map((s) => resolveImage(s)) : [],
  };
}

export function toStorefrontPageContent(published: Record<string, unknown>) {
  const localized = toStorefrontLocalized(published) as Record<string, unknown>;
  const { heroImageId, sections, ...rest } = localized;
  return {
    ...rest,
    heroImage: typeof heroImageId === 'string' ? mediaUrl(heroImageId) : null,
    sections: Array.isArray(sections) ? sections.map((s) => resolveImage(s)) : [],
  };
}
