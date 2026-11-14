import { z } from 'zod';
import { localized, SLUG_RE } from '../../shared/validation/common.schema.js';

export const SKU_RE = /^[A-Z0-9][A-Z0-9-]{1,39}$/;

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

export const statusSchema = z.object({ status: z.enum(['draft', 'active', 'archived']) });
