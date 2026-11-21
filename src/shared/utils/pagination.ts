// Shared server-side pagination: one set of named constants and one set of parsing
// rules for every paginated list (admin orders today, other lists as they migrate
// off client-side pagination). Defaults come from here, never from literals at
// each call site.

/** Default page size for admin lists. */
export const DEFAULT_PAGE_SIZE = 20;
/** Hard cap: no list endpoint ever returns more than this many rows per page. */
export const MAX_PAGE_SIZE = 100;

export function parsePage(value: unknown): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

export function parsePageSize(value: unknown, fallback: number = DEFAULT_PAGE_SIZE): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(MAX_PAGE_SIZE, n);
}

export function pageCountFor(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
}

/** Clamps a requested page into the available range (1..pageCount). */
export function clampPage(page: number, pageCount: number): number {
  return Math.min(Math.max(1, page), Math.max(1, pageCount));
}
