import { Router } from 'express';
import { z } from 'zod';
import { requireOwner } from '../auth.js';
import { route } from '../http.js';
import { prisma } from '../db.js';

// UI i18n — serves admin-defined string overrides for each language.
// The frontend bundles its own default strings; this endpoint returns only admin overrides
// (initially {}) which the frontend merges on top, letting admins customise any label.

export const uiI18nPublicRouter = Router();
export const uiI18nAdminRouter = Router();

const SUPPORTED = ['en', 'de', 'fr', 'it', 'es', 'en-US', 'en-GB', 'en-IN'] as const;
type SupportedLng = (typeof SUPPORTED)[number];

const isSupportedLng = (v: unknown): v is SupportedLng =>
  typeof v === 'string' && (SUPPORTED as readonly string[]).includes(v);

async function loadOverrides(lang: string): Promise<Record<string, unknown>> {
  try {
    const row = await prisma.$queryRaw<Array<{ data: string }>>`
      SELECT data FROM ui_translation_bundles WHERE lang = ${lang} LIMIT 1
    `;
    if (row.length && row[0].data) return JSON.parse(row[0].data) as Record<string, unknown>;
  } catch {
    // table may not exist yet if migration hasn't run
  }
  return {};
}

async function saveOverrides(lang: string, data: Record<string, unknown>): Promise<void> {
  const json = JSON.stringify(data);
  await prisma.$executeRawUnsafe(`
    INSERT INTO ui_translation_bundles (lang, data)
    VALUES (?, ?)
    ON DUPLICATE KEY UPDATE data = VALUES(data), updated_at = CURRENT_TIMESTAMP(3)
  `, lang, json);
}

// GET /api/i18n/:lng/translation — public, no auth
uiI18nPublicRouter.get(
  '/:lng/translation',
  route(async (req, res) => {
    const { lng } = req.params;
    if (!isSupportedLng(lng)) return res.json({});
    // en-* variants share the 'en' override bundle
    const lang = lng.startsWith('en') ? 'en' : lng;
    const overrides = await loadOverrides(lang);
    res.set('Cache-Control', 'public, max-age=60');
    res.json(overrides);
  }),
);

// Admin routes — owner only
uiI18nAdminRouter.use(requireOwner);

// GET /api/admin/i18n/:lng — list all overrides for a language
uiI18nAdminRouter.get(
  '/:lng',
  route(async (req, res) => {
    const { lng } = req.params;
    if (!isSupportedLng(lng)) return res.json({});
    const lang = lng.startsWith('en') ? 'en' : lng;
    const overrides = await loadOverrides(lang);
    res.json({ lang, overrides });
  }),
);

const putSchema = z.object({
  overrides: z.record(z.unknown()),
});

// PUT /api/admin/i18n/:lng — replace all overrides for a language
uiI18nAdminRouter.put(
  '/:lng',
  route(async (req, res) => {
    const { lng } = req.params;
    if (!isSupportedLng(lng)) return res.status(400).json({ error: 'Unsupported language' });
    const { overrides } = putSchema.parse(req.body);
    const lang = lng.startsWith('en') ? 'en' : lng;
    await saveOverrides(lang, overrides);
    res.json({ ok: true });
  }),
);

const patchSchema = z.object({
  key: z.string().trim().min(1),
  value: z.string(),
});

// PATCH /api/admin/i18n/:lng — set a single key override
uiI18nAdminRouter.patch(
  '/:lng',
  route(async (req, res) => {
    const { lng } = req.params;
    if (!isSupportedLng(lng)) return res.status(400).json({ error: 'Unsupported language' });
    const { key, value } = patchSchema.parse(req.body);
    const lang = lng.startsWith('en') ? 'en' : lng;
    const existing = await loadOverrides(lang);
    existing[key] = value;
    await saveOverrides(lang, existing);
    res.json({ ok: true });
  }),
);

// DELETE /api/admin/i18n/:lng — remove a single key override
uiI18nAdminRouter.delete(
  '/:lng',
  route(async (req, res) => {
    const { lng } = req.params;
    if (!isSupportedLng(lng)) return res.status(400).json({ error: 'Unsupported language' });
    const key = String(req.query.key ?? '');
    if (!key) return res.status(400).json({ error: 'key required' });
    const lang = lng.startsWith('en') ? 'en' : lng;
    const existing = await loadOverrides(lang);
    delete existing[key];
    await saveOverrides(lang, existing);
    res.json({ ok: true });
  }),
);
