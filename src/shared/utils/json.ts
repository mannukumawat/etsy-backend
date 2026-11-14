// List-ish catalog fields (tags, variant option maps, variant image ids) are stored as JSON text so
// the same schema runs on SQLite and PostgreSQL. These helpers are the only place that encoding lives.

export function parseStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function parseStringMap(value: string | null | undefined): Record<string, string> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
  } catch {
    return {};
  }
}

export const stringifyJson = (value: unknown): string => JSON.stringify(value ?? null);

/** Lowercase haystack used for case-insensitive search on engines without ILIKE. */
export function buildSearchText(parts: Array<string | null | undefined>): string {
  return parts
    .filter((p): p is string => !!p && p.trim().length > 0)
    .join(' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
