import { Router } from 'express';
import { route } from '../../shared/http/async-route.js';
import { requireOwner } from '../../shared/middleware/auth.middleware.js';
import { CONTENT_LANGS, upsertTranslationSchema } from './translation.schema.js';
import { listTranslations, saveTranslation } from './translation.service.js';
import { listUiTranslations, removeOverride, setOverride } from '../ui-i18n/ui-i18n.service.js';
import { setOverrideSchema } from '../ui-i18n/ui-i18n.schema.js';

// Owner-only translation memory management.

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
    res.json(await listTranslations({ q, status, lang, page, pageSize }));
  }),
);

translationsRouter.put(
  '/',
  route(async (req, res) => {
    const { removed } = await saveTranslation(upsertTranslationSchema.parse(req.body));
    res.json(removed ? { ok: true, removed: true } : { ok: true });
  }),
);

translationsRouter.get('/ui', route(async (req, res) => {
  const lang = CONTENT_LANGS.includes(String(req.query.lang) as never) ? String(req.query.lang) : 'de';
  const q = String(req.query.q ?? '').trim().toLowerCase();
  const status = String(req.query.status ?? 'all');
  const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize ?? '25'), 10) || 25));
  res.json(await listUiTranslations(lang, q, status, page, pageSize));
}));

translationsRouter.put('/ui', route(async (req, res) => {
  const { key, value } = setOverrideSchema.parse(req.body);
  const lang = CONTENT_LANGS.includes(String(req.body.lang) as never) ? String(req.body.lang) : null;
  if (!lang) throw new Error('Unsupported language.');
  if (value.trim()) await setOverride(lang, key, value.trim());
  else await removeOverride(lang, key);
  res.json({ ok: true });
}));
