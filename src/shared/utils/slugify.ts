/** URL-safe slug: lowercase letters, numbers and single hyphens (max 80 chars).
 *  The single shared implementation — do not copy this regex into another module. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
}
