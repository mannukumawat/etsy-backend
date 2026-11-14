import { Router } from 'express';
import { route } from '../../shared/http/async-route.js';
import { requireOwner } from '../../shared/middleware/auth.middleware.js';
import { isSupportedUiLang, replaceOverridesSchema, setOverrideSchema } from './ui-i18n.schema.js';
import { bundleLang, loadOverrides, removeOverride, replaceOverrides, setOverride } from './ui-i18n.service.js';

export const uiI18nAdminRouter = Router();

// Admin routes — owner only
uiI18nAdminRouter.use(requireOwner);

// GET /api/admin/i18n/:lng — list all overrides for a language
uiI18nAdminRouter.get(
  '/:lng',
  route(async (req, res) => {
    const { lng } = req.params;
    if (!isSupportedUiLang(lng)) return res.json({});
    const lang = bundleLang(lng);
    const overrides = await loadOverrides(lang);
    res.json({ lang, overrides });
  }),
);

// PUT /api/admin/i18n/:lng — replace all overrides for a language
uiI18nAdminRouter.put(
  '/:lng',
  route(async (req, res) => {
    const { lng } = req.params;
    if (!isSupportedUiLang(lng)) return res.status(400).json({ error: 'Unsupported language' });
    const { overrides } = replaceOverridesSchema.parse(req.body);
    await replaceOverrides(bundleLang(lng), overrides);
    res.json({ ok: true });
  }),
);

// PATCH /api/admin/i18n/:lng — set a single key override
uiI18nAdminRouter.patch(
  '/:lng',
  route(async (req, res) => {
    const { lng } = req.params;
    if (!isSupportedUiLang(lng)) return res.status(400).json({ error: 'Unsupported language' });
    const { key, value } = setOverrideSchema.parse(req.body);
    await setOverride(bundleLang(lng), key, value);
    res.json({ ok: true });
  }),
);

// DELETE /api/admin/i18n/:lng — remove a single key override
uiI18nAdminRouter.delete(
  '/:lng',
  route(async (req, res) => {
    const { lng } = req.params;
    if (!isSupportedUiLang(lng)) return res.status(400).json({ error: 'Unsupported language' });
    const key = String(req.query.key ?? '');
    if (!key) return res.status(400).json({ error: 'key required' });
    await removeOverride(bundleLang(lng), key);
    res.json({ ok: true });
  }),
);
