import { prisma } from '../../shared/database/prisma.js';
import { sha256Hex } from '../../shared/utils/crypto.js';
import { CONTENT_LANGS, type ContentLang, type UpsertTranslationInput } from './translation.schema.js';

// Storefront content translation.
//
// Store content is authored in English (`{ en, hi? }` "Localized" objects everywhere in API responses).
// Translations live in a translation memory keyed by the exact English text. When a request carries
// `x-lang: de|fr|it|es`, every Localized object in the JSON response gets an extra `[lang]` value if a
// translation exists for its English text. Edited English text no longer matches its old entry, so the
// storefront falls back to English rather than showing an outdated translation.

export const sourceHash = sha256Hex;

export type Localized = { en: string; [k: string]: unknown };
const isLocalized = (v: unknown): v is Localized => !!v && typeof v === 'object' && !Array.isArray(v) && typeof (v as Localized).en === 'string';

/** Every Localized object in a JSON value (depth-first). */
export function collectLocalized(value: unknown, out: Localized[]) {
  if (Array.isArray(value)) {
    for (const v of value) collectLocalized(v, out);
  } else if (value && typeof value === 'object') {
    if (isLocalized(value)) out.push(value);
    for (const v of Object.values(value)) if (v && typeof v === 'object') collectLocalized(v, out);
  }
}

export async function translateBody(body: unknown, lang: ContentLang): Promise<void> {
  const nodes: Localized[] = [];
  collectLocalized(body, nodes);
  const sources = [...new Set(nodes.map((n) => n.en.trim()).filter(Boolean))];
  if (!sources.length) return;
  const rows = await prisma.contentTranslation.findMany({ where: { lang, sourceHash: { in: sources.map(sourceHash) } }, select: { sourceHash: true, text: true } });
  const byHash = new Map(rows.map((r) => [r.sourceHash, r.text]));
  for (const n of nodes) {
    const t = byHash.get(sourceHash(n.en.trim()));
    if (t) n[lang] = t;
  }
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
      collectLocalized(JSON.parse(json), nodes);
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

// --- admin listing + editing ------------------------------------------------------------------------

export interface TranslationListQuery {
  /** Lowercased search text ('' = no filter). */
  q: string;
  /** 'all' | 'missing' | 'translated'. */
  status: string;
  /** A supported language code, or null for all languages. */
  lang: string | null;
  page: number;
  pageSize: number;
}

/** Sources are discovered live from current store content, so the list always matches what the
 *  storefront shows right now. */
export async function listTranslations({ q, status, lang, page, pageSize }: TranslationListQuery) {
  const sources = await storeSources();
  const rows = await prisma.contentTranslation.findMany({ where: { sourceHash: { in: sources.map((s) => sourceHash(s.text)) } }, select: { lang: true, sourceHash: true, text: true } });
  const byKey = new Map(rows.map((r) => [`${r.lang}:${r.sourceHash}`, r.text]));

  let items = sources.map((s) => {
    const h = sourceHash(s.text);
    const translations = Object.fromEntries(CONTENT_LANGS.map((l) => [l, byKey.get(`${l}:${h}`) ?? '']));
    return { source: s.text, where: s.where, translations };
  });
  const counts = Object.fromEntries(CONTENT_LANGS.map((l) => [l, items.filter((i) => i.translations[l]).length]));

  const langs = lang ? [lang] : [...CONTENT_LANGS];
  if (status === 'missing') items = items.filter((i) => langs.some((l) => !i.translations[l]));
  if (status === 'translated') items = items.filter((i) => langs.every((l) => i.translations[l]));
  if (q) items = items.filter((i) => i.source.toLowerCase().includes(q) || i.where.some((w) => w.toLowerCase().includes(q)) || Object.values(i.translations).some((t) => t.toLowerCase().includes(q)));

  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(page, pageCount);
  return { items: items.slice((current - 1) * pageSize, current * pageSize), total, page: current, pageCount, pageSize, sourceCount: sources.length, counts };
}

/** Empty text removes the translation (that string then shows in English). */
export async function saveTranslation({ source, lang, text }: UpsertTranslationInput): Promise<{ removed: boolean }> {
  const hash = sourceHash(source);
  if (!text) {
    await prisma.contentTranslation.deleteMany({ where: { lang, sourceHash: hash } });
    return { removed: true };
  }
  await prisma.contentTranslation.upsert({
    where: { lang_sourceHash: { lang, sourceHash: hash } },
    create: { lang, sourceHash: hash, source, text },
    update: { text, source },
  });
  return { removed: false };
}
