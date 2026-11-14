import { z } from 'zod';
import { localized } from '../../shared/validation/common.schema.js';

const urlOrEmpty = z
  .string()
  .trim()
  .refine((v) => v === '' || /^https?:\/\//i.test(v), 'Use a full https:// URL, or leave it blank.')
  .default('');

export const storeSettingsSchema = z.object({
  name: z.string().trim().min(1, 'Store name is required.').max(60),
  tagline: localized(160),
  logoId: z.string().nullable().default(null),
  contact: z.object({
    email: z.string().trim().email('Enter a valid email address.').or(z.literal('')).default(''),
    phone: z.string().trim().max(30).default(''),
    address: z.string().trim().max(300).default(''),
    hours: localized(200),
  }),
  social: z.object({
    instagram: urlOrEmpty,
    pinterest: urlOrEmpty,
    facebook: urlOrEmpty,
    youtube: urlOrEmpty,
  }),
  handlingDays: z
    .object({ min: z.number().int().min(0).max(30), max: z.number().int().min(0).max(30) })
    .refine((v) => v.max >= v.min, { message: 'Max handling days must be at least the minimum.', path: ['max'] }),
  maxQtyPerLine: z.number().int().min(1).max(99),
  lowStockThreshold: z.number().int().min(0).max(1000),
});
export type StoreSettingsInput = z.infer<typeof storeSettingsSchema>;

const shippingZoneSchema = z
  .object({
    id: z.string().min(1).optional(),
    name: z.string().trim().min(1, 'Zone name is required.').max(60),
    countries: z.array(z.string().length(2)).min(1, 'Add at least one country.'),
    standard: z.object({
      enabled: z.boolean(),
      rate: z.number().int().min(0).max(1_000_000),
      minDays: z.number().int().min(0).max(90),
      maxDays: z.number().int().min(0).max(90),
    }),
    express: z.object({
      enabled: z.boolean(),
      rate: z.number().int().min(0).max(1_000_000),
      minDays: z.number().int().min(0).max(90),
      maxDays: z.number().int().min(0).max(90),
    }),
  })
  .superRefine((z1, ctx) => {
    if (z1.standard.maxDays < z1.standard.minDays) ctx.addIssue({ code: 'custom', path: ['standard', 'maxDays'], message: 'Max days must be at least the minimum.' });
    if (z1.express.maxDays < z1.express.minDays) ctx.addIssue({ code: 'custom', path: ['express', 'maxDays'], message: 'Max days must be at least the minimum.' });
    if (!z1.standard.enabled && !z1.express.enabled) ctx.addIssue({ code: 'custom', path: ['standard', 'enabled'], message: 'Enable at least one shipping method.' });
  });

export const shippingSettingsSchema = z
  .object({
    zones: z.array(shippingZoneSchema).max(20),
    unsupportedMessage: localized(300),
  })
  .superRefine((input, ctx) => {
    const names = new Set<string>();
    const countrySeen = new Map<string, number>();
    input.zones.forEach((z1, zi) => {
      const key = z1.name.trim().toLowerCase();
      if (names.has(key)) ctx.addIssue({ code: 'custom', path: ['zones', zi, 'name'], message: 'Zone names must be unique.' });
      names.add(key);
      for (const code of z1.countries) {
        if (countrySeen.has(code)) {
          ctx.addIssue({ code: 'custom', path: ['zones', zi, 'countries'], message: `${code} is already assigned to another zone.` });
        }
        countrySeen.set(code, zi);
      }
    });
  });
export type ShippingSettingsInput = z.infer<typeof shippingSettingsSchema>;

const taxRuleSchema = z.object({
  id: z.string().min(1).optional(),
  country: z.string().length(2),
  region: z.string().trim().max(80).default(''),
  rate: z.number().min(0).max(50),
  label: z.string().trim().min(1, 'Label is required.').max(80),
});

export const taxSettingsSchema = z
  .object({
    pricesIncludeTax: z.boolean().default(false),
    defaultRate: z.number().min(0).max(50),
    rules: z.array(taxRuleSchema).max(200),
  })
  .superRefine((input, ctx) => {
    const seen = new Set<string>();
    input.rules.forEach((r, i) => {
      const key = `${r.country}|${r.region.trim().toLowerCase()}`;
      if (seen.has(key)) ctx.addIssue({ code: 'custom', path: ['rules', i, 'region'], message: 'Duplicate country/region rule.' });
      seen.add(key);
    });
  });
export type TaxSettingsInput = z.infer<typeof taxSettingsSchema>;

export const SUPPORTED_CURRENCY_CODES = ['USD', 'INR', 'EUR', 'GBP'] as const;

const currencyConfigSchema = z.object({
  code: z.enum(SUPPORTED_CURRENCY_CODES),
  name: z.string().trim().min(1).max(40),
  enabled: z.boolean(),
  rate: z.number().positive().max(100_000),
  autoRate: z.boolean().default(false),
  fractionDigits: z.number().int().min(0).max(4),
  roundingIncrement: z.number().int().positive().max(1000),
});

export const currencySettingsSchema = z
  .object({ currencies: z.array(currencyConfigSchema) })
  .superRefine((input, ctx) => {
    const codes = input.currencies.map((c) => c.code);
    for (const required of SUPPORTED_CURRENCY_CODES) {
      if (!codes.includes(required)) ctx.addIssue({ code: 'custom', path: ['currencies'], message: `${required} cannot be removed.` });
    }
    if (new Set(codes).size !== codes.length) ctx.addIssue({ code: 'custom', path: ['currencies'], message: 'Duplicate currency code.' });
    const usd = input.currencies.find((c) => c.code === 'USD');
    if (usd && (usd.rate !== 1 || !usd.enabled)) ctx.addIssue({ code: 'custom', path: ['currencies'], message: 'USD is the base currency: rate must be 1 and it must stay enabled.' });
  });
export type CurrencySettingsInput = z.infer<typeof currencySettingsSchema>;
