import { z } from 'zod';

// Server-side rules. The apps validate too, for fast feedback, but these are the authoritative ones:
// a client can be edited, so prices, stock, slugs and SKUs are all re-checked here.

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SKU_RE = /^[A-Z0-9][A-Z0-9-]{1,39}$/;

export const localized = (maxLen = 5000, requireEn = false) =>
  z.object({
    en: requireEn ? z.string().trim().min(1, 'English text is required.').max(maxLen) : z.string().trim().max(maxLen).default(''),
    hi: z.string().trim().max(maxLen).default(''),
  });

/** Non-negative integer minor units. */
const money = z.number().int('Use whole minor units.').min(0, 'Cannot be negative.');
const optionalMoney = z.number().int().positive('Must be above zero, or null.').nullable().default(null);
const measure = z.number().min(0, 'Cannot be negative.').nullable().default(null);

export const productInputSchema = z
  .object({
    slug: z.string().trim().regex(SLUG_RE, 'Use lowercase letters, numbers and single hyphens.'),
    status: z.enum(['draft', 'active', 'archived']).default('draft'),
    name: localized(120, true),
    shortDescription: localized(300),
    description: localized(5000),
    categoryId: z.string().min(1, 'Choose a category.'),
    itemGroupId: z.string().nullable().optional(),
    navLinkId: z.string().nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(30)).max(20).default([]),
    basePrice: money,
    baseSalePrice: optionalMoney,
    images: z
      .array(z.object({ mediaId: z.string().min(1), alt: localized(200) }))
      .max(20)
      .default([]),
    options: z
      .array(
        z.object({
          id: z.string().min(1),
          name: localized(40, true),
          type: z.enum(['swatch', 'button']).default('button'),
          values: z
            .array(
              z.object({
                id: z.string().min(1),
                label: localized(40, true),
                swatch: z
                  .string()
                  .regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #C04A17.')
                  .nullable()
                  .default(null),
              }),
            )
            .min(1, 'Add at least one value.'),
        }),
      )
      .max(3, 'Use at most 3 options.')
      .default([]),
    variants: z
      .array(
        z.object({
          id: z.string().min(1),
          sku: z.string().trim().transform((s) => s.toUpperCase()).pipe(z.string().regex(SKU_RE, 'SKU: 2–40 characters, A–Z, 0–9 and hyphens.')),
          options: z.record(z.string()).default({}),
          price: money,
          salePrice: optionalMoney,
          stock: z.number().int('Whole numbers only.').min(0, 'Stock cannot be negative.').max(1_000_000),
          imageIds: z.array(z.string()).default([]),
        }),
      )
      .min(1, 'At least one variant is required.')
      .max(250, 'A product can have at most 250 variants. Reduce the number of option values.'),
    weight: z.object({ value: measure, unit: z.enum(['g', 'kg']).default('g') }).default({ value: null, unit: 'g' }),
    dimensions: z
      .object({ length: measure, width: measure, height: measure, unit: z.enum(['cm', 'in']).default('cm') })
      .default({ length: null, width: null, height: null, unit: 'cm' }),
    specs: z.array(z.object({ id: z.string().min(1), label: localized(40, true), value: localized(80, true) })).max(30).default([]),
    materials: localized(500),
    care: localized(1000),
    returnsAllowed: z.boolean().default(true),
    exchangeAllowed: z.boolean().default(true),
    returnDays: z.number().int().min(1).max(365).default(30),
    isFeatured: z.boolean().default(false),
    isBestseller: z.boolean().default(false),
    isNew: z.boolean().default(false),
    displayOrder: z.number().int().min(0).max(100000).default(100),
    seo: z.object({ title: localized(70), description: localized(160) }).default({ title: { en: '', hi: '' }, description: { en: '', hi: '' } }),
  })
  .superRefine((p, ctx) => {
    const add = (path: (string | number)[], message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });

    if (p.baseSalePrice !== null && p.baseSalePrice >= p.basePrice) add(['baseSalePrice'], 'Sale price must be lower than the base price.');

    // Images referenced by variants must belong to the product.
    const imageIds = new Set(p.images.map((i) => i.mediaId));
    if (imageIds.size !== p.images.length) add(['images'], 'The same image is added twice.');

    // Option/value ids must be unique and variants must match a real combination.
    const optionIds = new Set<string>();
    for (const [oi, o] of p.options.entries()) {
      if (optionIds.has(o.id)) add(['options', oi, 'id'], 'Duplicate option id.');
      optionIds.add(o.id);
      const valueIds = new Set<string>();
      const labels = new Set<string>();
      for (const [vi, v] of o.values.entries()) {
        if (valueIds.has(v.id)) add(['options', oi, 'values', vi, 'id'], 'Duplicate value id.');
        valueIds.add(v.id);
        const label = v.label.en.trim().toLowerCase();
        if (labels.has(label)) add(['options', oi, 'values', vi, 'label', 'en'], 'Duplicate value in this option.');
        labels.add(label);
      }
    }

    const expected = p.options.reduce<number>((n, o) => n * o.values.length, 1);
    const seenSkus = new Set<string>();
    const seenCombos = new Set<string>();
    for (const [i, v] of p.variants.entries()) {
      if (seenSkus.has(v.sku)) add(['variants', i, 'sku'], 'SKU is used twice in this product.');
      seenSkus.add(v.sku);

      if (v.salePrice !== null && v.salePrice >= v.price) add(['variants', i, 'salePrice'], 'Sale price must be lower than the price.');
      if (v.imageIds.some((id) => !imageIds.has(id))) add(['variants', i, 'imageIds'], 'Variant images must be chosen from the product images.');

      const combo = p.options.map((o) => v.options[o.id] ?? '').join('|');
      if (p.options.length) {
        for (const o of p.options) {
          const chosen = v.options[o.id];
          if (!chosen || !o.values.some((x) => x.id === chosen)) add(['variants', i, 'options'], `Variant does not have a valid ${o.name.en || 'option'} value.`);
        }
        if (seenCombos.has(combo)) add(['variants', i], 'Duplicate variant combination.');
        seenCombos.add(combo);
      }

      if (p.status === 'active' && v.price <= 0) add(['variants', i, 'price'], 'Active products need a price above zero.');
    }
    if (p.options.length && p.variants.length !== expected) {
      add(['variants'], `Expected ${expected} variants for the chosen options, got ${p.variants.length}.`);
    }

    // Extra requirements to be publicly visible.
    if (p.status === 'active') {
      if (!p.images.length) add(['images'], 'Add at least one image before activating.');
      if (!p.shortDescription.en.trim()) add(['shortDescription', 'en'], 'Short description is required to activate.');
      if (!p.description.en.trim()) add(['description', 'en'], 'Description is required to activate.');
      if (p.basePrice <= 0) add(['basePrice'], 'Active products need a price above zero.');
    }
  });

export type ProductInput = z.infer<typeof productInputSchema>;

export const categoryInputSchema = z.object({
  slug: z.string().trim().regex(SLUG_RE, 'Use lowercase letters, numbers and single hyphens.'),
  name: localized(60, true),
  description: localized(300),
  imageId: z.string().nullable().default(null),
  bannerId: z.string().nullable().default(null),
  displayOrder: z.number().int().min(0).max(100000).default(0),
  isActive: z.boolean().default(true),
});

export const loginSchema = z.object({
  email: z.string().trim().email('Enter a valid email address.'),
  password: z.string().min(1, 'Password is required.'),
});

export const statusSchema = z.object({ status: z.enum(['draft', 'active', 'archived']) });

export const mediaUploadSchema = z.object({
  fileName: z.string().trim().min(1).max(200),
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml']),
  /** Raw base64 (no data: prefix). ~5 MB decoded ceiling. */
  base64: z.string().min(1).max(7_500_000),
  width: z.number().int().positive().nullable().default(null),
  height: z.number().int().positive().nullable().default(null),
  alt: localized(200),
});

export const mediaUrlImportSchema = z.object({
  url: z.string().trim().url('Enter a valid image URL.').refine((value) => /^https?:\/\//i.test(value), 'Use an http:// or https:// image URL.'),
  alt: localized(200),
});

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

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


// ---------------------------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------------------------

export const ADJUSTMENT_REASONS = ['restock', 'correction', 'damaged', 'returned', 'other'] as const;

export const inventoryAdjustSchema = z
  .object({
    variantId: z.string().min(1),
    mode: z.enum(['add', 'remove', 'set']),
    quantity: z.number().int('Whole numbers only.').min(0, 'Cannot be negative.').max(1_000_000),
    reason: z.enum(ADJUSTMENT_REASONS),
    note: z.string().trim().max(300).default(''),
  })
  .refine((v) => v.reason !== 'other' || v.note.length >= 3, { message: 'Add a note of at least 3 characters for "Other".', path: ['note'] });
export type InventoryAdjustInput = z.infer<typeof inventoryAdjustSchema>;

// ---------------------------------------------------------------------------------------------
// Content: homepage + the 7 fixed information/policy pages
// ---------------------------------------------------------------------------------------------

const isSiteLinkOrUrl = (href: string) => href === '' || href.startsWith('/') || /^https?:\/\//i.test(href);

const idList = (max: number) =>
  z
    .array(z.string().min(1))
    .max(max, `Choose at most ${max}.`)
    .default([])
    .refine((arr) => new Set(arr).size === arr.length, 'The same item is listed twice.');

export const homepageContentSchema = z
  .object({
    announcement: z.object({ enabled: z.boolean().default(false), text: localized(140) }),
    hero: z.object({
      title: localized(120, true),
      subtitle: localized(240),
      imageId: z.string().nullable().default(null),
      ctaLabel: localized(40, true),
      ctaHref: z.string().trim().default(''),
    }),
    featuredCategoryIds: z.array(z.string().min(1)).max(50).default([]),
    featuredProductIds: idList(12),
    bestsellerProductIds: idList(12),
    newArrivalProductIds: idList(12),
    itemsProductIds: idList(12),
    transferProductIds: idList(12),
    story: z.object({
      title: localized(120, true),
      body: localized(2000),
      imageId: z.string().nullable().default(null),
      ctaLabel: localized(40),
      ctaHref: z.string().trim().default(''),
    }),
    newsletter: z.object({ title: localized(120, true), body: localized(300) }),
  })
  .superRefine((c, ctx) => {
    const add = (path: (string | number)[], message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
    if (c.announcement.enabled && !c.announcement.text.en.trim()) add(['announcement', 'text', 'en'], 'Announcement text is required while the bar is enabled.');
    if (!isSiteLinkOrUrl(c.hero.ctaHref)) add(['hero', 'ctaHref'], 'Use a site path like /shop or a full https:// URL.');
    if (c.story.ctaHref && !isSiteLinkOrUrl(c.story.ctaHref)) add(['story', 'ctaHref'], 'Use a site path like /about or a full https:// URL.');
  });
export type HomepageContentInput = z.infer<typeof homepageContentSchema>;

export const pageContentSchema = z.object({
  title: localized(100, true),
  intro: localized(500),
  sections: z
    .array(z.object({ id: z.string().min(1), heading: localized(100, true), body: localized(3000, true) }))
    .max(30, 'Use at most 30 sections.')
    .default([]),
});
export type PageContentInput = z.infer<typeof pageContentSchema>;

export const PAGE_KEYS = ['about', 'contact', 'faq', 'shipping', 'returns', 'privacy', 'terms'] as const;
export type PageKey = (typeof PAGE_KEYS)[number];

// ---------------------------------------------------------------------------------------------
// Customer auth, profile, addresses, wishlist
// ---------------------------------------------------------------------------------------------

export const customerEmailField = z.string().trim().min(1).email('Enter a valid email address.').max(120);
export const customerPasswordField = z
  .string()
  .min(8, 'Use at least 8 characters.')
  .max(72)
  .regex(/[A-Za-z]/, 'Include at least one letter.')
  .regex(/\d/, 'Include at least one number.');

const phoneDigits = (v: string) => v.replace(/[\s\-().]/g, '');
/** Profile phone: optional, allows a leading "+" (matches frontend/src/utils/validation.ts profileSchema). */
export const customerPhoneField = z
  .string()
  .trim()
  .refine((v) => v === '' || /^\+?\d{6,15}$/.test(phoneDigits(v)), 'Enter a valid phone number.')
  .default('');

export const customerRegisterSchema = z.object({
  name: z.string().trim().min(2, 'Enter your full name.').max(80),
  email: customerEmailField,
  password: customerPasswordField,
});
export type CustomerRegisterInput = z.infer<typeof customerRegisterSchema>;

export const customerLoginSchema = z.object({ email: customerEmailField, password: z.string().min(1, 'Password is required.') });

export const customerProfileSchema = z.object({
  name: z.string().trim().min(2, 'Enter your full name.').max(80),
  email: customerEmailField,
  phone: customerPhoneField,
});
export type CustomerProfileInput = z.infer<typeof customerProfileSchema>;

export const customerAddressSchema = z.object({
  label: z.string().trim().min(1, 'Label is required.').max(30),
  isDefault: z.boolean().default(false),
  fullName: z.string().trim().min(2, 'Enter a full name.').max(80),
  phoneCountry: z.string().trim().min(1, 'Required.'),
  phone: z.string().trim().min(1, 'Phone is required.').refine((v) => /^\d{6,14}$/.test(phoneDigits(v)), 'Enter a valid phone number.'),
  country: z.string().length(2, 'Choose a country.'),
  line1: z.string().trim().min(3, 'Address line is required.').max(120),
  line2: z.string().trim().max(120).default(''),
  city: z.string().trim().max(80).default(''),
  region: z.string().trim().max(80).default(''),
  postalCode: z.string().trim().max(12).default(''),
});
export type CustomerAddressInput = z.infer<typeof customerAddressSchema>;

export const passwordResetRequestSchema = z.object({ email: customerEmailField });
export const passwordResetConfirmSchema = z.object({
  token: z.string().min(1, 'Reset link is invalid.'),
  password: customerPasswordField,
});

export const wishlistToggleSchema = z.object({ productId: z.string().min(1), variantId: z.string().min(1).optional() });

// ---------------------------------------------------------------------------------------------
// Coupons
// ---------------------------------------------------------------------------------------------

export const COUPON_CODE_RE = /^[A-Z0-9][A-Z0-9_-]{2,19}$/;
export const normalizeCouponCode = (code: string) => code.trim().toUpperCase();

export const couponInputSchema = z
  .object({
    code: z.string().trim().transform(normalizeCouponCode).pipe(z.string().regex(COUPON_CODE_RE, 'Code: 3–20 characters, letters, numbers, "-" or "_".')),
    description: z.string().trim().max(300).default(''),
    type: z.enum(['percentage', 'fixed']),
    value: z.number(),
    maxDiscount: z.number().int().nullable().default(null),
    minOrder: z.number().int().nullable().default(null),
    startsAt: z.coerce.date().nullable().default(null),
    endsAt: z.coerce.date().nullable().default(null),
    isActive: z.boolean().default(true),
    usageLimit: z.number().int().nullable().default(null),
    perCustomerLimit: z.number().int().nullable().default(null),
    scope: z.enum(['all', 'products', 'categories']).default('all'),
    productIds: z.array(z.string()).default([]),
    categoryIds: z.array(z.string()).default([]),
  })
  .superRefine((input, ctx) => {
    const add = (path: (string | number)[], message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
    if (input.type === 'percentage') {
      if (!Number.isFinite(input.value) || input.value <= 0 || input.value > 100) add(['value'], 'Percentage must be more than 0 and at most 100.');
      if (input.maxDiscount !== null && input.maxDiscount <= 0) add(['maxDiscount'], 'Maximum discount must be above zero, or empty.');
    } else {
      if (!Number.isInteger(input.value) || input.value <= 0) add(['value'], 'Fixed discount must be above zero.');
      if (input.maxDiscount !== null) add(['maxDiscount'], 'Maximum discount only applies to percentage coupons.');
    }
    if (input.minOrder !== null && input.minOrder < 0) add(['minOrder'], 'Minimum order cannot be negative.');
    if (input.type === 'fixed' && input.minOrder !== null && input.minOrder > 0 && input.value > input.minOrder) {
      add(['value'], 'A fixed discount larger than the minimum order could make orders free.');
    }
    if (input.startsAt && input.endsAt && input.endsAt <= input.startsAt) add(['endsAt'], 'End date must be after the start date.');
    const posInt = (n: number | null) => n === null || (Number.isInteger(n) && n >= 1);
    if (!posInt(input.usageLimit)) add(['usageLimit'], 'Usage limit must be a whole number of at least 1, or empty.');
    if (!posInt(input.perCustomerLimit)) add(['perCustomerLimit'], 'Per-customer limit must be at least 1, or empty.');
    if (input.usageLimit !== null && input.perCustomerLimit !== null && input.perCustomerLimit > input.usageLimit) {
      add(['perCustomerLimit'], 'Per-customer limit cannot exceed the total usage limit.');
    }
    if (input.scope === 'products' && input.productIds.length === 0) add(['productIds'], 'Choose at least one product.');
    if (input.scope === 'categories' && input.categoryIds.length === 0) add(['categoryIds'], 'Choose at least one category.');
  });
export type CouponInput = z.infer<typeof couponInputSchema>;

export const applyCouponSchema = z.object({ code: z.string().trim().min(1).max(30) });

// ---------------------------------------------------------------------------------------------
// Checkout / orders
// ---------------------------------------------------------------------------------------------

export const orderAddressSchema = customerAddressSchema.omit({ label: true, isDefault: true });
export type OrderAddressInput = z.infer<typeof orderAddressSchema>;

export const checkoutLineSchema = z.object({
  productId: z.string().min(1),
  variantId: z.string().min(1),
  quantity: z.number().int('Whole numbers only.').min(1).max(10),
});

export const validateCouponSchema = z.object({
  code: z.string().trim().min(1).max(30),
  lines: z.array(checkoutLineSchema).min(1),
  currency: z.enum(SUPPORTED_CURRENCY_CODES),
});

export const checkoutTotalsSchema = z.object({
  lines: z.array(checkoutLineSchema).min(1, 'Your cart is empty.').max(50),
  currency: z.enum(SUPPORTED_CURRENCY_CODES),
  country: z.string().length(2, 'Choose a destination country.'),
  shippingMethodId: z.enum(['standard', 'express']),
  couponCode: z.string().trim().max(30).optional(),
});
export type CheckoutTotalsInput = z.infer<typeof checkoutTotalsSchema>;

export const PAYMENT_METHODS = ['cod', 'card', 'upi', 'wallet'] as const;

export const placeOrderSchema = z.object({
  idempotencyKey: z.string().trim().min(1, 'Missing idempotency key.').max(100),
  lines: z.array(checkoutLineSchema).min(1, 'Your cart is empty.').max(50),
  currency: z.enum(SUPPORTED_CURRENCY_CODES),
  email: customerEmailField,
  address: orderAddressSchema,
  shippingMethodId: z.enum(['standard', 'express']),
  paymentMethod: z.enum(PAYMENT_METHODS),
  couponCode: z.string().trim().max(30).optional(),
});
export type PlaceOrderInput = z.infer<typeof placeOrderSchema>;

export const orderTrackSchema = z.object({
  number: z.string().trim().min(1, 'Enter your order number.'),
  email: customerEmailField,
});

export const ADMIN_FULFILMENT_STATUSES = ['unfulfilled', 'processing', 'shipped', 'delivered', 'cancelled'] as const;

export const advanceOrderSchema = z
  .object({
    to: z.enum(ADMIN_FULFILMENT_STATUSES),
    carrier: z.string().trim().max(60).optional(),
    trackingNumber: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9-]{4,40}$/, 'Use 4–40 letters, numbers or hyphens.')
      .optional(),
    trackingUrl: z.string().trim().url('Enter a valid URL.').optional().or(z.literal('')),
  })
  .superRefine((input, ctx) => {
    if (input.to === 'shipped' && (!input.carrier?.trim() || !input.trackingNumber)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['trackingNumber'], message: 'Carrier and tracking number are required to mark an order shipped.' });
    }
  });

export const updateTrackingSchema = z.object({
  carrier: z.string().trim().min(1, 'Carrier is required.').max(60),
  trackingNumber: z.string().trim().regex(/^[A-Za-z0-9-]{4,40}$/, 'Use 4–40 letters, numbers or hyphens.'),
  trackingUrl: z.string().trim().url('Enter a valid URL.').optional().or(z.literal('')),
});

export const cancelOrderSchema = z.object({
  restock: z.boolean().default(true),
  refund: z.boolean().default(true),
  reason: z.string().trim().min(1, 'Give a reason for the cancellation.').max(300),
});

export const refundOrderSchema = z.object({
  amount: z.number().int('Use whole minor units.').positive('Refund must be above zero.'),
  reason: z.string().trim().min(1, 'Give a reason for the refund.').max(300),
});

export const addNoteSchema = z.object({ body: z.string().trim().min(1, 'Note cannot be empty.').max(1000) });

// ---------------------------------------------------------------------------------------------
// Navigation links + curated collections
// ---------------------------------------------------------------------------------------------

const isSiteLinkOrFullUrl = (href: string) => href.startsWith('/') || /^https?:\/\//i.test(href);

export const navLinkInputSchema = z.object({
  labelEn: z.string().trim().min(1, 'Label is required.').max(40),
  labelHi: z.string().trim().max(40).default(''),
  href: z
    .string()
    .trim()
    .min(1, 'Link is required.')
    .max(200)
    .refine(isSiteLinkOrFullUrl, 'Use a site path like /collection/wedding-guide or a full https:// URL.'),
  isActive: z.boolean().default(true),
  position: z.number().int().min(0).max(1000).default(0),
});
export type NavLinkInput = z.infer<typeof navLinkInputSchema>;

export const collectionCircleInputSchema = z
  .object({
    labelEn: z.string().trim().min(1, 'Label is required.').max(40),
    labelHi: z.string().trim().max(40).default(''),
    imageId: z.string().nullable().default(null),
    linkType: z.enum(['category', 'collection', 'url']),
    linkValue: z.string().trim().min(1, 'Choose a destination.').max(200),
  })
  .superRefine((c, ctx) => {
    if (c.linkType === 'url' && !isSiteLinkOrFullUrl(c.linkValue)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['linkValue'], message: 'Use a site path or a full https:// URL.' });
    }
  });

export const collectionSectionInputSchema = z.object({
  titleEn: z.string().trim().min(1, 'Section title is required.').max(60),
  titleHi: z.string().trim().max(60).default(''),
  productIds: z.array(z.string().min(1)).max(60).default([]),
});

export const collectionInputSchema = z.object({
  slug: z.string().trim().regex(SLUG_RE, 'Use lowercase letters, numbers and single hyphens.'),
  titleEn: z.string().trim().min(1, 'Title is required.').max(80),
  titleHi: z.string().trim().max(80).default(''),
  subtitleEn: z.string().trim().max(200).default(''),
  subtitleHi: z.string().trim().max(200).default(''),
  descriptionEn: z.string().trim().max(2000).default(''),
  descriptionHi: z.string().trim().max(2000).default(''),
  heroImageId: z.string().nullable().default(null),
  heroColor: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #F5ECE1.')
    .default('#F5ECE1'),
  displayOrder: z.number().int().min(0).max(100000).default(0),
  showInNavigation: z.boolean().default(false),
  circles: z.array(collectionCircleInputSchema).max(12, 'Use at most 12 circles.').default([]),
  sections: z.array(collectionSectionInputSchema).min(1, 'Add at least one product section.').max(10, 'Use at most 10 sections.'),
});
export type CollectionInput = z.infer<typeof collectionInputSchema>;

export const collectionStatusSchema = z.object({ status: z.enum(['draft', 'published']) });

// --- reviews ------------------------------------------------------------------------------------

/** Optional free text: trimmed, empty string stored as null. Ownership, eligibility, order and
 *  moderation status are never accepted from the client — `.strict()` rejects any such extra key. */
const optionalText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, `${label} must be ${max} characters or fewer.`)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));

export const reviewInputSchema = z
  .object({
    rating: z.number({ invalid_type_error: 'Choose a rating from 1 to 5.' }).int('Choose a whole-star rating.').min(1, 'Choose a rating from 1 to 5.').max(5, 'Choose a rating from 1 to 5.'),
    title: optionalText(120, 'Title'),
    body: optionalText(2000, 'Review'),
    photos: z.array(z.string().min(1)).max(5, 'Maximum 5 photos per review.').optional().default([]),
  })
  .strict();

export const reviewCreateSchema = reviewInputSchema.extend({ productId: z.string().min(1) }).strict();

export const reviewModerationSchema = z.object({
  reason: z.string().trim().min(3, 'Give a short reason (at least 3 characters).').max(500),
});

// ---------------------------------------------------------------------------------------------
// Cancellation + Returns
// ---------------------------------------------------------------------------------------------

export const cancelLineSchema = z.object({
  qty: z.number().int().min(1),
  reason: z.enum(['changed_mind', 'duplicate_order', 'wrong_item_ordered', 'price_issue', 'other']),
  note: z.string().max(500).optional(),
});

export const createReturnSchema = z.object({
  orderId: z.string().min(1),
  lineId: z.string().min(1),
  qty: z.number().int().min(1),
  reason: z.enum(['damaged', 'wrong_item', 'not_as_described', 'changed_mind', 'quality_issue', 'other']),
  note: z.string().max(1000).optional(),
  photos: z.array(z.string()).max(5).optional().default([]),
  shippingMethod: z.enum(['self_ship', 'pickup']).optional(),
});

export const approveReturnSchema = z.object({
  approvedQty: z.number().int().min(1),
  shippingFee: z.number().int().min(0).optional(),
  note: z.string().max(1000).optional(),
});

export const rejectReturnSchema = z.object({
  reason: z.string().min(1).max(1000),
});

export const arrangePickupSchema = z.object({
  pickupAddress: z.string().min(1),
  carrier: z.string().optional(),
  note: z.string().max(500).optional(),
});

export const recordReturnShippingSchema = z.object({
  carrier: z.string().min(1),
  tracking: z.string().min(1),
});

export const receiveReturnSchema = z.object({
  receivedQty: z.number().int().min(0),
  note: z.string().max(500).optional(),
});

export const inspectReturnSchema = z.object({
  acceptedQty: z.number().int().min(0),
  rejectedQty: z.number().int().min(0),
  restockAccepted: z.boolean().default(true),
  note: z.string().max(1000).optional(),
});

export const processReturnRefundSchema = z.object({
  amount: z.number().int().min(1),
  method: z.enum(['original', 'manual_bank', 'manual_upi', 'store_credit']),
  reference: z.string().max(200).optional(),
  note: z.string().max(500).optional(),
});

export const addReturnNoteSchema = z.object({
  body: z.string().min(1).max(2000),
});

export const codCollectionSchema = z.object({
  amount: z.number().int().positive(),
  collectedAt: z.string().datetime({ offset: true }).or(z.string().datetime()),
  collector: z.string().min(1).max(100),
  reference: z.string().max(100).optional(),
  note: z.string().max(500).optional(),
});
