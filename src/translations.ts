import { createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { prisma } from './db.js';

// Storefront content translation.
//
// Store content is authored in English (`{ en, hi? }` "Localized" objects everywhere in API responses).
// Translations live in a translation memory keyed by the exact English text. When a request carries
// `x-lang: de|fr|it|es`, every Localized object in the JSON response gets an extra `[lang]` value if a
// translation exists for its English text. Edited English text no longer matches its old entry, so the
// storefront falls back to English rather than showing an outdated translation.

export const CONTENT_LANGS = ['de', 'fr', 'it', 'es'] as const;
export type ContentLang = (typeof CONTENT_LANGS)[number];

export const isContentLang = (v: unknown): v is ContentLang => typeof v === 'string' && (CONTENT_LANGS as readonly string[]).includes(v);
export const sourceHash = (text: string) => createHash('sha256').update(text).digest('hex');

type Localized = { en: string; [k: string]: unknown };
const isLocalized = (v: unknown): v is Localized => !!v && typeof v === 'object' && !Array.isArray(v) && typeof (v as Localized).en === 'string';

/** Every Localized object in a JSON value (depth-first). */
function collect(value: unknown, out: Localized[]) {
  if (Array.isArray(value)) {
    for (const v of value) collect(v, out);
  } else if (value && typeof value === 'object') {
    if (isLocalized(value)) out.push(value);
    for (const v of Object.values(value)) if (v && typeof v === 'object') collect(v, out);
  }
}

export async function translateBody(body: unknown, lang: ContentLang): Promise<void> {
  const nodes: Localized[] = [];
  collect(body, nodes);
  const sources = [...new Set(nodes.map((n) => n.en.trim()).filter(Boolean))];
  if (!sources.length) return;
  const rows = await prisma.contentTranslation.findMany({ where: { lang, sourceHash: { in: sources.map(sourceHash) } }, select: { sourceHash: true, text: true } });
  const byHash = new Map(rows.map((r) => [r.sourceHash, r.text]));
  for (const n of nodes) {
    const t = byHash.get(sourceHash(n.en.trim()));
    if (t) n[lang] = t;
  }
}

/** Hindi has been removed from the store. Content saved before that (homepage/page JSON, legacy
 *  columns) may still carry a `hi` value, so it is stripped from every JSON response, admin included. */
export function stripHindi(value: unknown): void {
  const nodes: Localized[] = [];
  collect(value, nodes);
  for (const n of nodes) delete n.hi;
}

export function stripHindiResponses(_req: Request, res: Response, next: NextFunction) {
  const send = res.json.bind(res);
  res.json = ((body: unknown) => {
    stripHindi(body);
    return send(body);
  }) as Response['json'];
  next();
}

/** Applies to GET responses only; admin requests never send the header, so they're untouched. */
export function translateResponses(req: Request, res: Response, next: NextFunction) {
  const lang = req.get('x-lang');
  if (req.method !== 'GET' || !isContentLang(lang) || req.path.startsWith('/api/admin')) return next();
  const send = res.json.bind(res);
  res.json = ((body: unknown) => {
    translateBody(body, lang)
      .catch((e) => console.error('translation overlay failed:', e))
      .finally(() => send(body));
    return res;
  }) as Response['json'];
  res.vary('x-lang');
  next();
}

// --- source discovery (for the admin Translations screen) -------------------------------------------

export interface SourceString {
  text: string;
  /** Where it appears, e.g. "Product · Everyday Speckled Mug". */
  where: string[];
}

/** All English strings currently shown on the storefront, deduplicated, with where they're used. */
export async function storeSources(): Promise<SourceString[]> {
  const map = new Map<string, Set<string>>();
  const add = (text: string | null | undefined, where: string) => {
    const t = text?.trim();
    if (!t) return;
    if (!map.has(t)) map.set(t, new Set());
    map.get(t)!.add(where);
  };
  const addJson = (json: string | null | undefined, where: string) => {
    if (!json) return;
    const nodes: Localized[] = [];
    try {
      collect(JSON.parse(json), nodes);
    } catch {
      return;
    }
    for (const n of nodes) add(n.en, where);
  };

  const [products, categories, homepage, pages, navLinks, collections, store] = await Promise.all([
    prisma.product.findMany({
      where: { status: { not: 'archived' } },
      include: { options: { include: { values: true } }, specs: true, images: true },
      orderBy: { displayOrder: 'asc' },
    }),
    prisma.category.findMany({ orderBy: { displayOrder: 'asc' } }),
    prisma.homepageContent.findUnique({ where: { id: 'singleton' } }),
    prisma.pageDoc.findMany(),
    prisma.navLink.findMany({ orderBy: { position: 'asc' } }),
    prisma.collection.findMany({ include: { circles: true, sections: true } }),
    prisma.storeSettings.findUnique({ where: { id: 'singleton' } }),
  ]);

  if (store) {
    add(store.taglineEn, 'Store settings');
    add(store.contactHoursEn, 'Store settings');
  }
  addJson(homepage?.publishedJson, 'Homepage');
  for (const p of pages) addJson(p.publishedJson, `Page · ${p.key}`);
  for (const n of navLinks) add(n.labelEn, 'Navigation');
  for (const c of categories) {
    add(c.nameEn, `Category · ${c.nameEn}`);
    add(c.descriptionEn, `Category · ${c.nameEn}`);
  }
  for (const c of collections) {
    const w = `Collection · ${c.titleEn}`;
    add(c.titleEn, w);
    add(c.subtitleEn, w);
    add(c.descriptionEn, w);
    for (const ci of c.circles) add(ci.labelEn, w);
    for (const s of c.sections) add(s.titleEn, w);
  }
  for (const p of products) {
    const w = `Product · ${p.nameEn}`;
    add(p.nameEn, w);
    add(p.shortDescriptionEn, w);
    add(p.descriptionEn, w);
    add(p.materialsEn, w);
    add(p.careEn, w);
    for (const o of p.options) {
      add(o.nameEn, w);
      for (const v of o.values) add(v.labelEn, w);
    }
    for (const i of p.images) add(i.altEn, w);
  }
  return [...map.entries()].map(([text, where]) => ({ text, where: [...where] }));
}
