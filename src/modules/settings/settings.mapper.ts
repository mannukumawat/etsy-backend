import type { CurrencyConfig, CurrencySettings, ShippingSettings, ShippingZone, StoreSettings, TaxRule, TaxSettings } from '@prisma/client';
import { parseStringArray } from '../../shared/utils/json.js';
import { L } from '../../shared/utils/localized.js';

export function toAdminStoreSettings(s: {
  nameEn: string; taglineEn: string; taglineHi: string; logoId: string | null;
  contactEmail: string; contactPhone: string; contactAddress: string; contactHoursEn: string; contactHoursHi: string;
  socialInstagram: string; socialPinterest: string; socialFacebook: string; socialYoutube: string;
  handlingMinDays: number; handlingMaxDays: number; maxQtyPerLine: number; lowStockThreshold: number; updatedAt: Date;
}) {
  return {
    name: s.nameEn,
    tagline: L(s.taglineEn, s.taglineHi),
    logoId: s.logoId,
    contact: { email: s.contactEmail, phone: s.contactPhone, address: s.contactAddress, hours: L(s.contactHoursEn, s.contactHoursHi) },
    social: { instagram: s.socialInstagram, pinterest: s.socialPinterest, facebook: s.socialFacebook, youtube: s.socialYoutube },
    handlingDays: { min: s.handlingMinDays, max: s.handlingMaxDays },
    maxQtyPerLine: s.maxQtyPerLine,
    lowStockThreshold: s.lowStockThreshold,
    updatedAt: s.updatedAt.toISOString(),
  };
}

export function toAdminShippingZone(z: {
  id: string; nameEn: string; countries: string;
  standardEnabled: boolean; standardRate: number; standardMinDays: number; standardMaxDays: number;
  expressEnabled: boolean; expressRate: number; expressMinDays: number; expressMaxDays: number;
}) {
  return {
    id: z.id,
    name: z.nameEn,
    countries: parseStringArray(z.countries),
    standard: { enabled: z.standardEnabled, rate: z.standardRate, minDays: z.standardMinDays, maxDays: z.standardMaxDays },
    express: { enabled: z.expressEnabled, rate: z.expressRate, minDays: z.expressMinDays, maxDays: z.expressMaxDays },
  };
}

export function toAdminTaxRule(r: { id: string; country: string; region: string; rate: number; label: string }) {
  return { id: r.id, country: r.country, region: r.region, rate: r.rate, label: r.label };
}

export function toAdminCurrencyConfig(c: { code: string; name: string; enabled: boolean; rate: number; autoRate: boolean; fractionDigits: number; roundingIncrement: number }) {
  return { code: c.code, name: c.name, enabled: c.enabled, rate: c.rate, autoRate: c.code !== 'USD' && c.autoRate, fractionDigits: c.fractionDigits, roundingIncrement: c.roundingIncrement };
}

/** All four admin settings sections as one document — what GET /api/admin/settings and every PUT return. */
export function toAdminSettings(s: {
  store: StoreSettings;
  shipping: ShippingSettings & { zones: ShippingZone[] };
  tax: TaxSettings & { rules: TaxRule[] };
  currencies: CurrencySettings & { currencies: CurrencyConfig[] };
}) {
  const { store, shipping, tax, currencies } = s;
  return {
    store: toAdminStoreSettings(store),
    shipping: { zones: shipping.zones.map(toAdminShippingZone), unsupportedMessage: { en: shipping.unsupportedMessageEn, hi: shipping.unsupportedMessageHi }, freeShippingThreshold: shipping.freeShippingThreshold ?? null, updatedAt: shipping.updatedAt.toISOString() },
    tax: { pricesIncludeTax: tax.pricesIncludeTax, defaultRate: tax.defaultRate, rules: tax.rules.map(toAdminTaxRule), updatedAt: tax.updatedAt.toISOString() },
    currencies: { base: currencies.base, currencies: currencies.currencies.map(toAdminCurrencyConfig), ratesUpdatedAt: currencies.ratesUpdatedAt.toISOString(), autoSyncAt: currencies.autoSyncAt ? currencies.autoSyncAt.toISOString() : null, autoSyncError: currencies.autoSyncError, updatedAt: currencies.updatedAt.toISOString() },
  };
}

/** A safe subset for display: store identity/contact, enabled currencies for the currency switcher,
 *  language configuration, and illustrative shipping rates/times (the same non-sensitive numbers the
 *  storefront already bundled statically) so the shipping info page can show live admin-edited rates.
 *  The logo is served as a resolvable URL (H1): the id alone was unusable — no consumer could
 *  turn it into an image. `logoUrl` prefers the Cloudinary URL when the media lives there. */
export function toPublicSettings(s: {
  store: StoreSettings;
  currencies: CurrencySettings & { currencies: CurrencyConfig[] };
  shipping: ShippingSettings & { zones: ShippingZone[] };
  logoUrl?: string | null;
  /** L-S8: live shop-profile stats, computed by getPublicSettings from reviews/orders. */
  stats?: { rating: number; reviewCount: number; salesCount: number } | null;
}) {
  const { store, currencies, shipping } = s;
  const location = store.contactAddress.trim();
  return {
    store: {
      name: store.nameEn,
      tagline: { en: store.taglineEn, ...(store.taglineHi ? { hi: store.taglineHi } : {}) },
      logo: store.logoId ? { id: store.logoId, ...(s.logoUrl ? { url: s.logoUrl } : {}) } : null,
      // L-S8: the storefront's shop profile reads `store.location` / `store.stats`
      // and they were never returned, so both were always undefined. Location is
      // the contact address the owner already maintains; stats are computed live
      // (see getPublicSettings) — no new settings fields were invented for them.
      ...(location ? { location } : {}),
      ...(s.stats ? { stats: s.stats } : {}),
      contact: {
        email: store.contactEmail,
        phone: store.contactPhone,
        address: store.contactAddress,
        hours: { en: store.contactHoursEn },
      },
      social: { instagram: store.socialInstagram, pinterest: store.socialPinterest, facebook: store.socialFacebook, youtube: store.socialYoutube },
      // M-S1: published so the storefront can stop hardcoding the delivery window
      // and the per-line quantity cap (frontend config/store.ts + utils/dates.ts).
      handlingDays: { min: store.handlingMinDays, max: store.handlingMaxDays },
      maxQtyPerLine: store.maxQtyPerLine,
    },
    currencies: currencies.currencies.map((c) => ({ code: c.code, name: c.name, rate: c.rate, fractionDigits: c.fractionDigits, roundingIncrement: c.roundingIncrement })),
    shipping: {
      zones: shipping.zones.map(toAdminShippingZone),
      unsupportedMessage: { en: shipping.unsupportedMessageEn },
      // M-S2: USD minor units (null = no threshold); the storefront converts it like any price.
      freeShippingThreshold: shipping.freeShippingThreshold ?? null,
    },
  };
}
