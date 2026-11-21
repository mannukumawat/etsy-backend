import { prisma } from '../../shared/database/prisma.js';
import { UI_DEFAULTS } from './ui-defaults.js';

// UI i18n — serves admin-defined string overrides for each language.
// The frontend bundles its own default strings; this endpoint returns only admin overrides
// (initially {}) which the frontend merges on top, letting admins customise any label.

/** en-* variants share the 'en' override bundle. */
export const bundleLang = (lng: string) => (lng.startsWith('en') ? 'en' : lng);

export async function loadOverrides(lang: string): Promise<Record<string, unknown>> {
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

export async function replaceOverrides(lang: string, data: Record<string, unknown>): Promise<void> {
  const json = JSON.stringify(data);
  await prisma.$executeRawUnsafe(`
    INSERT INTO ui_translation_bundles (lang, data)
    VALUES (?, ?)
    ON DUPLICATE KEY UPDATE data = VALUES(data), updated_at = CURRENT_TIMESTAMP(3)
  `, lang, json);
}

export async function setOverride(lang: string, key: string, value: string): Promise<void> {
  const existing = await loadOverrides(lang);
  const parts = key.split('.');
  let cursor = existing;
  for (const part of parts.slice(0, -1)) {
    const child = cursor[part];
    cursor[part] = child && typeof child === 'object' && !Array.isArray(child) ? child : {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts.at(-1)!] = value;
  await replaceOverrides(lang, existing);
}

export async function removeOverride(lang: string, key: string): Promise<void> {
  const existing = await loadOverrides(lang);
  const parts = key.split('.');
  let cursor: Record<string, unknown> | undefined = existing;
  for (const part of parts.slice(0, -1)) {
    const child: unknown = cursor?.[part];
    cursor = child && typeof child === 'object' && !Array.isArray(child) ? child as Record<string, unknown> : undefined;
  }
  if (cursor) delete cursor[parts.at(-1)!];
  await replaceOverrides(lang, existing);
}

function flatten(value: unknown, prefix = '', out: Record<string, string> = {}) {
  if (typeof value === 'string') out[prefix] = value;
  else if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) flatten(child, prefix ? `${prefix}.${key}` : key, out);
  }
  return out;
}

export async function listUiTranslations(lang: string, q: string, status: string, page: number, pageSize: number) {
  const defaults = flatten(UI_DEFAULTS);
  const supportedLanguages = ['de', 'fr', 'it', 'es'] as const;
  const bundles = await Promise.all(supportedLanguages.map(async (code) => [code, flatten(await loadOverrides(code))] as const));
  const overridesByLanguage = Object.fromEntries(bundles) as Record<string, Record<string, string>>;
  const overrides = overridesByLanguage[lang] ?? {};
  let items = Object.entries(defaults).map(([key, source]) => ({
    key, source, where: [`Interface · ${key}`], translations: { [lang]: overrides[key] ?? '' },
  }));
  if (status === 'missing') items = items.filter((item) => !item.translations[lang]);
  if (status === 'translated') items = items.filter((item) => !!item.translations[lang]);
  if (q) items = items.filter((item) => `${item.key} ${item.source} ${item.translations[lang]}`.toLowerCase().includes(q));
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(page, pageCount);
  const counts = Object.fromEntries(supportedLanguages.map((code) => [
    code,
    Object.keys(overridesByLanguage[code]).filter((key) => key in defaults).length,
  ]));
  return { items: items.slice((current - 1) * pageSize, current * pageSize), total, page: current, pageCount, pageSize, sourceCount: Object.keys(defaults).length, counts };
}
