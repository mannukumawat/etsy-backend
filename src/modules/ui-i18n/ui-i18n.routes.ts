import { Router } from 'express';
import { route } from '../../shared/http/async-route.js';
import { isSupportedUiLang } from './ui-i18n.schema.js';
import { bundleLang, loadOverrides } from './ui-i18n.service.js';

export const uiI18nPublicRouter = Router();

// GET /api/i18n/:lng/translation — public, no auth
uiI18nPublicRouter.get(
  '/:lng/translation',
  route(async (req, res) => {
    const { lng } = req.params;
    if (!isSupportedUiLang(lng)) return res.json({});
    const overrides = await loadOverrides(bundleLang(lng));
    // M20: the edge needs s-maxage to cache this at all — max-age alone only governs the browser.
    res.set('Cache-Control', 'public, max-age=60, s-maxage=60');
    res.json(overrides);
  }),
);
