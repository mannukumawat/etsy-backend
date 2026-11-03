import { Router } from 'express';
import { z } from 'zod';
import { requireOwner } from '../auth.js';
import { prisma } from '../db.js';
import { route } from '../http.js';
import { CONTENT_LANGS, sourceHash, storeSources } from '../translations.js';

// Owner-only translation memory management. Sources are discovered live from current store content,
// so the list always matches what the storefront shows right now.

export const translationsRouter = Router();
translationsRouter.use(requireOwner);

translationsRouter.get(
  '/',
  route(async (req, res) => {
    const q = String(req.query.q ?? '').trim().toLowerCase();
    const status = String(req.query.status ?? 'all');
    const lang = CONTENT_LANGS.includes(String(req.query.lang) as never) ? String(req.query.lang) : null;
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize ?? '25'), 10) || 25));

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
    res.json({ items: items.slice((current - 1) * pageSize, current * pageSize), total, page: current, pageCount, pageSize, sourceCount: sources.length, counts });
  }),
);

const upsertSchema = z.object({
  source: z.string().trim().min(1),
  lang: z.enum(CONTENT_LANGS),
  text: z.string().trim().max(20000),
});

/** Empty text removes the translation (that string then shows in English). */
translationsRouter.put(
  '/',
  route(async (req, res) => {
    const { source, lang, text } = upsertSchema.parse(req.body);
    const hash = sourceHash(source);
    if (!text) {
      await prisma.contentTranslation.deleteMany({ where: { lang, sourceHash: hash } });
      return res.json({ ok: true, removed: true });
    }
    await prisma.contentTranslation.upsert({
      where: { lang_sourceHash: { lang, sourceHash: hash } },
      create: { lang, sourceHash: hash, source, text },
      update: { text, source },
    });
    res.json({ ok: true });
  }),
);
