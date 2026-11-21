// Product search: one place for the search haystack builder and the search query
// builder, shared by the product editor (product.service.ts), the Excel import
// (import.service.ts) and both product lists (storefront + admin). Keeping them
// here means an imported product is searchable exactly like a saved one, and both
// lists use the same full-text / LIKE decision.

/** MySQL `ft_min_word_len` default: words shorter than this are invisible to FULLTEXT. */
export const FULLTEXT_MIN_WORD_LENGTH = 4;

/** Lowercase haystack used for case-insensitive search on engines without ILIKE. */
export function buildProductSearchText(parts: Array<string | null | undefined>): string {
  return parts
    .filter((p): p is string => !!p && p.trim().length > 0)
    .join(' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Escape the LIKE wildcards in a user value so it can only ever match literally. */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export type ProductSearchQuery =
  | { mode: 'fulltext'; booleanQuery: string }
  | { mode: 'like'; pattern: string };

/**
 * Turns a shopper/owner search string into a database query.
 *
 * MySQL FULLTEXT (`MATCH(searchText) AGAINST(? IN BOOLEAN MODE)`) uses the
 * `@@fulltext([searchText])` index instead of a `LIKE '%q%'` full-table scan, but
 * it can only see words of at least {@link FULLTEXT_MIN_WORD_LENGTH} characters.
 * So: split the query into words, drop anything shorter than that (MySQL would
 * ignore it anyway), and require every surviving word as a prefix
 * (`+term*`). When no word survives — the whole query is short words like "rug"
 * or "2x3" — fall back to the LIKE path so short searches still find products.
 *
 * The boolean query is built from letters and digits only: splitting on
 * anything else strips every boolean-mode operator (`+ - > < ( ) ~ * " @`)
 * before the terms are joined, and the result is always passed to the database
 * as a bound parameter, never interpolated into SQL.
 */
export function buildProductSearchQuery(q: string): ProductSearchQuery {
  const lowered = q.trim().toLowerCase();
  // Hyphenated words ("hand-woven") become separate terms ("hand" + "woven");
  // accented letters survive because the split keeps Unicode letters/digits.
  const terms = lowered
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length >= FULLTEXT_MIN_WORD_LENGTH);
  if (terms.length > 0) {
    return { mode: 'fulltext', booleanQuery: terms.map((t) => `+${t}*`).join(' ') };
  }
  return { mode: 'like', pattern: `%${escapeLikePattern(lowered)}%` };
}
