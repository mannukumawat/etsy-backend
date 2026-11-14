/** Store content is English-only. The legacy `…Hi` columns are never read into API responses. */
export const L = (en: string, _hi?: string) => ({ en });
/** Storefront `Localized` omits empty translations so its English fallback kicks in. */
export const Lopt = (en: string, _hi?: string) => ({ en });
