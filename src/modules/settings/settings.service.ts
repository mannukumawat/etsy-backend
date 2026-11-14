import { timingSafeEqual } from 'node:crypto';
import { env } from '../../shared/config/env.js';
import { prisma } from '../../shared/database/prisma.js';
import { badRequest, HttpError, notFound } from '../../shared/errors/http-error.js';
import { stringifyJson } from '../../shared/utils/json.js';
import { syncLiveRates } from './exchange-rate.service.js';
import { toAdminSettings, toPublicSettings } from './settings.mapper.js';
import type { CurrencySettingsInput, ShippingSettingsInput, StoreSettingsInput, TaxSettingsInput } from './settings.schema.js';

// Four independently-editable settings sections (store, shipping, tax, currencies), each
// backed by its own singleton row (id = "singleton", created on first read by prisma/seed.ts) plus
// child rows for shipping zones / tax rules / currency configs. GET combines all five; each PUT
// replaces exactly one section, matching the five separate admin settings pages.

export async function loadAdminSettings() {
  const [store, shipping, tax, currencies] = await Promise.all([
    prisma.storeSettings.findUniqueOrThrow({ where: { id: 'singleton' } }),
    prisma.shippingSettings.findUniqueOrThrow({ where: { id: 'singleton' }, include: { zones: { orderBy: { position: 'asc' } } } }),
    prisma.taxSettings.findUniqueOrThrow({ where: { id: 'singleton' }, include: { rules: true } }),
    prisma.currencySettings.findUniqueOrThrow({ where: { id: 'singleton' }, include: { currencies: true } }),
  ]);
  return toAdminSettings({ store, shipping, tax, currencies });
}

export async function saveStoreSettings(input: StoreSettingsInput) {
  if (input.logoId) {
    const media = await prisma.media.findUnique({ where: { id: input.logoId }, select: { id: true } });
    if (!media) throw badRequest('Unknown logo image.', [{ path: 'logoId', message: 'Image not found.' }]);
  }
  await prisma.storeSettings.upsert({
    where: { id: 'singleton' },
    create: {
      id: 'singleton',
      nameEn: input.name, taglineEn: input.tagline.en, taglineHi: input.tagline.hi, logoId: input.logoId,
      contactEmail: input.contact.email, contactPhone: input.contact.phone, contactAddress: input.contact.address,
      contactHoursEn: input.contact.hours.en, contactHoursHi: input.contact.hours.hi,
      socialInstagram: input.social.instagram, socialPinterest: input.social.pinterest, socialFacebook: input.social.facebook, socialYoutube: input.social.youtube,
      handlingMinDays: input.handlingDays.min, handlingMaxDays: input.handlingDays.max,
      maxQtyPerLine: input.maxQtyPerLine, lowStockThreshold: input.lowStockThreshold,
    },
    update: {
      nameEn: input.name, taglineEn: input.tagline.en, taglineHi: input.tagline.hi, logoId: input.logoId,
      contactEmail: input.contact.email, contactPhone: input.contact.phone, contactAddress: input.contact.address,
      contactHoursEn: input.contact.hours.en, contactHoursHi: input.contact.hours.hi,
      socialInstagram: input.social.instagram, socialPinterest: input.social.pinterest, socialFacebook: input.social.facebook, socialYoutube: input.social.youtube,
      handlingMinDays: input.handlingDays.min, handlingMaxDays: input.handlingDays.max,
      maxQtyPerLine: input.maxQtyPerLine, lowStockThreshold: input.lowStockThreshold,
    },
  });
  return loadAdminSettings();
}

export async function saveShippingSettings(input: ShippingSettingsInput) {
  await prisma.$transaction(async (tx) => {
    await tx.shippingSettings.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', unsupportedMessageEn: input.unsupportedMessage.en, unsupportedMessageHi: input.unsupportedMessage.hi },
      update: { unsupportedMessageEn: input.unsupportedMessage.en, unsupportedMessageHi: input.unsupportedMessage.hi },
    });
    await tx.shippingZone.deleteMany({ where: { settingsId: 'singleton' } });
    if (input.zones.length) {
      await tx.shippingZone.createMany({
        data: input.zones.map((z, position) => ({
          settingsId: 'singleton',
          nameEn: z.name,
          countries: stringifyJson(z.countries),
          standardEnabled: z.standard.enabled, standardRate: z.standard.rate, standardMinDays: z.standard.minDays, standardMaxDays: z.standard.maxDays,
          expressEnabled: z.express.enabled, expressRate: z.express.rate, expressMinDays: z.express.minDays, expressMaxDays: z.express.maxDays,
          position,
        })),
      });
    }
  });
  return loadAdminSettings();
}

export async function saveTaxSettings(input: TaxSettingsInput) {
  await prisma.$transaction(async (tx) => {
    await tx.taxSettings.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', pricesIncludeTax: input.pricesIncludeTax, defaultRate: input.defaultRate },
      update: { pricesIncludeTax: input.pricesIncludeTax, defaultRate: input.defaultRate },
    });
    await tx.taxRule.deleteMany({ where: { settingsId: 'singleton' } });
    if (input.rules.length) {
      await tx.taxRule.createMany({ data: input.rules.map((r) => ({ settingsId: 'singleton', country: r.country, region: r.region, rate: r.rate, label: r.label })) });
    }
  });
  return loadAdminSettings();
}

export async function saveCurrencySettings(input: CurrencySettingsInput) {
  const before = await prisma.currencyConfig.findMany({ where: { settingsId: 'singleton' } });
  const rateChanged = input.currencies.some((c) => {
    const prev = before.find((b) => b.code === c.code);
    return !prev || prev.rate !== c.rate;
  });
  await prisma.$transaction(async (tx) => {
    await tx.currencySettings.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', base: 'USD', ...(rateChanged ? { ratesUpdatedAt: new Date() } : {}) },
      update: { base: 'USD', ...(rateChanged ? { ratesUpdatedAt: new Date() } : {}) },
    });
    await tx.currencyConfig.deleteMany({ where: { settingsId: 'singleton' } });
    await tx.currencyConfig.createMany({
      data: input.currencies.map((c) => ({ settingsId: 'singleton', code: c.code, name: c.name, enabled: c.enabled, rate: c.rate, autoRate: c.code !== 'USD' && c.autoRate, fractionDigits: c.fractionDigits, roundingIncrement: c.roundingIncrement })),
    });
  });
  return loadAdminSettings();
}

/** Fetch live exchange rates right now for every currency marked "Live" (the same job the scheduler runs). */
export async function refreshLiveCurrencyRates() {
  const live = await prisma.currencyConfig.count({ where: { settingsId: 'singleton', autoRate: true, code: { not: 'USD' } } });
  if (!live) throw badRequest('Turn on “Live rate” for at least one currency and save, then refresh.');
  try {
    await syncLiveRates();
  } catch (e) {
    throw new HttpError(502, 'upstream_error', e instanceof Error ? e.message : 'Could not fetch live rates.');
  }
  return loadAdminSettings();
}

// Checkout ITSELF never trusts the public settings: /api/checkout/totals recomputes shipping/tax
// server-side from the same tables, so a tampered client value can never change what an order is
// actually charged.
export async function getPublicSettings() {
  const [store, currencies, shipping] = await Promise.all([
    prisma.storeSettings.findUniqueOrThrow({ where: { id: 'singleton' } }),
    prisma.currencySettings.findUniqueOrThrow({ where: { id: 'singleton' }, include: { currencies: { where: { enabled: true } } } }),
    prisma.shippingSettings.findUniqueOrThrow({ where: { id: 'singleton' }, include: { zones: { orderBy: { position: 'asc' } } } }),
  ]);
  return toPublicSettings({ store, currencies, shipping });
}

/** Called by a scheduler on hosts that cannot keep a timer alive (Vercel Cron sends
 *  `Authorization: Bearer $CRON_SECRET`). Disabled (404) unless CRON_SECRET is configured. */
export async function syncRatesFromCron(authorizationHeader: string | undefined) {
  const secret = env.CRON_SECRET;
  if (!secret) throw notFound();
  const given = Buffer.from(authorizationHeader ?? '');
  const expected = Buffer.from(`Bearer ${secret}`);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new HttpError(401, 'unauthorized', 'Invalid cron secret.');
  const result = await syncLiveRates();
  return { ok: true, source: result.source, updated: result.updated.length, skipped: result.skipped };
}
