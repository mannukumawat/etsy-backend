import { prisma } from '../../shared/database/prisma.js';

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
  existing[key] = value;
  await replaceOverrides(lang, existing);
}

export async function removeOverride(lang: string, key: string): Promise<void> {
  const existing = await loadOverrides(lang);
  delete existing[key];
  await replaceOverrides(lang, existing);
}
