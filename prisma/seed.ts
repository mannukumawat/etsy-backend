import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { compositeArt, productArt, type ArtSpec } from './art.js';
import { PRODUCT_SOURCES as BASE_PRODUCT_SOURCES, type ProductSource } from './catalogSource.js';
import { EXTRA_CATEGORY_SOURCES, EXTRA_PRODUCT_SOURCES } from './extraCatalog.js';

const PRODUCT_SOURCES: ProductSource[] = [...BASE_PRODUCT_SOURCES, ...EXTRA_PRODUCT_SOURCES];
import { COUNTRIES, SHIPPING_ZONES, ZONE_NAME, type ShippingZoneId } from './countries.js';

// Idempotent development seed: safe to run repeatedly. Everything is upserted by a stable id, so
// re-running never duplicates rows and never clobbers edits made through the admin after seeding
// (products already present are left alone unless SEED_FORCE=1).
//
// IDs, slugs, SKUs, USD prices, stock and EN/HI copy are the same values both apps already ship.

const prisma = new PrismaClient();
const FORCE = process.env.SEED_FORCE === '1';
// Demo customer and sample catalog/nav/collections are illustrative content, not required for the
// store to run — off by default unless explicitly requested, so a routine `db:seed` run on a real
// store never recreates a demo shopper or sample products.
const SEED_DEMO_CUSTOMER = process.env.SEED_DEMO_CUSTOMER === '1';
const SEED_SAMPLE_CATALOG = process.env.SEED_SAMPLE_CATALOG === '1';

const svg = (dataUri: string) => Buffer.from(decodeURIComponent(dataUri.replace('data:image/svg+xml;charset=utf-8,', '')), 'utf8');

type Localized = { en: string; hi: string };
const L = (en: string, hi = ''): Localized => ({ en, hi });

// ---------------------------------------------------------------------------------------------
// Categories (same four the apps ship)
// ---------------------------------------------------------------------------------------------

const CATEGORY_SOURCES: Array<{
  id: string;
  name: Localized;
  description: Localized;
  image: ArtSpec;
  banner: Parameters<typeof compositeArt>[2];
  theme: 'warm' | 'sage' | 'soft' | 'linen' | 'stone' | 'blush';
}> = [
  {
    id: 'ceramics',
    name: L('Ceramics', ''),
    description: L('Wheel-thrown mugs, bowls and vases for slower, more meaningful days.', ''),
    image: { kind: 'bowl', color: '#e9dfcc', seed: 'cat' },
    banner: [
      { spec: { kind: 'bowl', color: '#e9dfcc' }, x: 980, baseY: 360, scale: 0.75 },
      { spec: { kind: 'mug', color: '#e6d3b8' }, x: 1220, baseY: 368, scale: 0.85 },
      { spec: { kind: 'plates', color: '#e8dcc8' }, x: 1440, baseY: 372, scale: 0.6 },
    ],
    theme: 'warm',
  },
  {
    id: 'bags',
    name: L('Bags', ''),
    description: L('Woven, stitched and block-printed bags made to be carried every day.', ''),
    image: { kind: 'basketBag', color: '#d2ae72', accent: '#8a5530', seed: 'cat' },
    banner: [
      { spec: { kind: 'basketBag', color: '#d2ae72', accent: '#8a5530' }, x: 1020, baseY: 372, scale: 0.68 },
      { spec: { kind: 'crossbody', color: '#a86b3c' }, x: 1280, baseY: 372, scale: 0.62 },
      { spec: { kind: 'clutch', color: '#f1e9da', accent: '#2f4a7a', pattern: 'print' }, x: 1470, baseY: 372, scale: 0.55 },
    ],
    theme: 'sage',
  },
  {
    id: 'jewellery',
    name: L('Jewellery', ''),
    description: L('Small-batch brass and silver pieces, hammered and finished by hand.', ''),
    image: { kind: 'necklace', color: '#c9a04f', seed: 'cat' },
    banner: [
      { spec: { kind: 'candle', color: '#e7dccb', accent: '#8a5a3c' }, x: 1050, baseY: 372, scale: 0.8 },
      { spec: { kind: 'vase', color: '#ede6d8', accent: '#2f4a7a' }, x: 1300, baseY: 372, scale: 0.55 },
      { spec: { kind: 'bowl', color: '#d9c7a8' }, x: 1480, baseY: 372, scale: 0.5 },
    ],
    theme: 'soft',
  },
  {
    id: 'home-decor',
    name: L('Home Decor', ''),
    description: L('Lamps, cushions, candles and planters that make a house feel lived-in.', ''),
    image: { kind: 'lamp', color: '#c49a63', seed: 'cat' },
    banner: [
      { spec: { kind: 'planter', color: '#c46a43' }, x: 1000, baseY: 372, scale: 0.5 },
      { spec: { kind: 'lamp', color: '#c49a63' }, x: 1230, baseY: 372, scale: 0.72 },
      { spec: { kind: 'candle', color: '#c9cfc0', accent: '#5c6b4a' }, x: 1450, baseY: 372, scale: 0.7 },
    ],
    theme: 'warm',
  },
];

/** Structured dimensions/weight, matching the admin seed. */
const PHYSICAL: Record<string, { l: number | null; w: number | null; h: number | null; g: number | null; specs?: Array<[string, string, string]> }> = {
  'p-mug': { l: 12, w: 8.5, h: 9.5, g: 340, specs: [['Capacity', '', '320 ml (11 oz)']] },
  'p-bowl': { l: 15, w: 15, h: 7, g: 420, specs: [['Capacity', '', '600 ml (20 oz)']] },
  'p-vase': { l: 11, w: 11, h: 16, g: 380 },
  'p-plates': { l: 27, w: 27, h: 2.5, g: 1600 },
  'p-teapot': { l: 24, w: 15, h: 15, g: 900, specs: [['Capacity', '', '900 ml (30 oz)']] },
  'p-market-bag': { l: 40, w: 18, h: 32, g: 550 },
  'p-canvas-tote': { l: 36, w: 10, h: 38, g: 300, specs: [['Handle drop', '', '28 cm (11 in)']] },
  'p-crossbody': { l: 24, w: 7, h: 17, g: 450, specs: [['Strap length', '', '110–130 cm']] },
  'p-jute-clutch': { l: 26, w: 4, h: 14, g: 180 },
  'p-print-pouch': { l: 23, w: 2, h: 15, g: 60 },
  'p-leaf-necklace': { l: null, w: null, h: null, g: 6, specs: [['Pendant size', '', '3.5 cm']] },
  'p-hoops': { l: 3, w: 0.3, h: 3, g: 3 },
  'p-moonstone-ring': { l: null, w: null, h: null, g: 3, specs: [['Band width', '', '1.5 mm'], ['Stone size', '', '≈ 5 mm']] },
  'p-bracelet': { l: null, w: null, h: null, g: 20, specs: [['Bead size', '', '8 mm'], ['Wrist size', '', '16–18 cm']] },
  'p-jhumka': { l: null, w: null, h: null, g: 14, specs: [['Drop length', '', '5.5 cm']] },
  'p-lamp': { l: 34, w: 34, h: 45, g: 1800 },
  'p-candle': { l: 8, w: 8, h: 9, g: 420, specs: [['Burn time', '', '≈ 40 h']] },
  'p-cushion': { l: 45, w: 45, h: null, g: 200 },
  'p-macrame': { l: 40, w: 2, h: 65, g: 350, specs: [['Large size', '', '60 × 95 cm']] },
  'p-planter': { l: 14, w: 14, h: 12, g: 600, specs: [['Large size', '', '22 × 19 cm']] },
};

const SCENE_ALT = [
  { en: 'on a wooden table', hi: '' },
  { en: 'close-up detail', hi: '' },
  { en: 'styled shot', hi: '' },
];

function combos(options: ProductSource['options'] = []): Record<string, string>[] {
  return options.reduce<Record<string, string>[]>((acc, o) => acc.flatMap((c) => o.values.map((v) => ({ ...c, [o.id]: v.id }))), [{}]);
}

async function upsertMedia(id: string, dataUri: string, fileName: string, alt: Localized, width = 800, height = 800) {
  const data = svg(dataUri);
  await prisma.media.upsert({
    where: { id },
    update: { fileName, mimeType: 'image/svg+xml', sizeBytes: data.length, width, height, altEn: alt.en, altHi: alt.hi, data, source: 'seed' },
    create: { id, fileName, mimeType: 'image/svg+xml', sizeBytes: data.length, width, height, altEn: alt.en, altHi: alt.hi, data, source: 'seed' },
  });
  return id;
}

/** Matches frontend/src/config/store.ts DEMO_ACCOUNT exactly, so the storefront's "fill demo
 *  credentials" button keeps working once API mode replaces the mock in-memory account. */
async function seedDemoCustomer() {
  const email = 'demo@yourstore.example';
  const passwordHash = await bcrypt.hash('DemoPass123', 10);
  await prisma.customer.upsert({ where: { email }, update: {}, create: { email, name: 'Demo Customer', passwordHash } });
  console.log(`  customer   ${email} (demo)`);
}

async function seedOwner() {
  const email = (process.env.OWNER_EMAIL ?? 'owner@yourstore.example').toLowerCase();
  const existing = await prisma.owner.findUnique({ where: { email } });
  if (existing) {
    // Never overwrite a real owner's stored credentials on a routine re-seed. There is no reset-password
    // CLI yet; intentionally changing it today means updating the `owners` row's passwordHash directly.
    console.log(`  owner      ${email} (already exists — credentials left untouched)`);
    return;
  }
  const passwordHash = await bcrypt.hash(process.env.OWNER_PASSWORD ?? 'AdminDemo2026', 10);
  const name = process.env.OWNER_NAME ?? 'Store Owner';
  await prisma.owner.create({ data: { email, name, passwordHash } });
  console.log(`  owner      ${email} (created)`);
}

async function seedCategories() {
  let created = 0;
  for (const [i, c] of [...CATEGORY_SOURCES, ...EXTRA_CATEGORY_SOURCES].entries()) {
    // Never overwrite a category the owner may have edited in the admin (unless SEED_FORCE=1).
    if (!FORCE && (await prisma.category.findUnique({ where: { id: c.id }, select: { id: true } }))) continue;
    created++;
    const imageId = await upsertMedia(`m_cat_${c.id}`, productArt(c.image, 0), `category-${c.id}.svg`, L(`${c.name.en} category image`, ''));
    const bannerId = await upsertMedia(`m_banner_${c.id}`, compositeArt(1600, 420, c.banner, c.theme, 330), `banner-${c.id}.svg`, L(`${c.name.en} banner`), 1600, 420);
    const data = {
      slug: c.id,
      nameEn: c.name.en,
      nameHi: c.name.hi,
      descriptionEn: c.description.en,
      descriptionHi: c.description.hi,
      imageId,
      bannerId,
      displayOrder: (i + 1) * 10,
      isActive: true,
    };
    await prisma.category.upsert({ where: { id: c.id }, update: data, create: { id: c.id, ...data } });
  }
  console.log(`  categories ${created} written, ${CATEGORY_SOURCES.length + EXTRA_CATEGORY_SOURCES.length - created} already present`);
}

async function seedProduct(src: ProductSource) {
  const existing = await prisma.product.findUnique({ where: { id: src.id }, select: { id: true } });
  if (existing && !FORCE) return false;

  const options = src.options ?? [];
  const name = L(src.name.en, src.name.hi ?? '');

  // One media set per distinct artwork, so colour variants get their own image (as in both apps).
  const imageIds: string[] = [];
  const imageAlts = new Map<string, Localized>();
  const artCache = new Map<string, string[]>();
  let n = 0;

  const addArt = async (art: ArtSpec, label: string | null, scenes: Array<0 | 1 | 2>) => {
    const key = JSON.stringify(art);
    const cached = artCache.get(key);
    if (cached) return cached;
    const ids: string[] = [];
    for (const scene of scenes) {
      const id = `m_${src.id.replace('p-', '')}_${++n}`;
      const alt = L(
        `${name.en}${label ? ` in ${label}` : ''}, ${SCENE_ALT[scene].en}`,
        name.hi ? `${name.hi}${label ? ` (${label})` : ''}, ${SCENE_ALT[scene].hi}` : '',
      );
      await upsertMedia(id, productArt(art, scene), `${src.slug}-${n}.svg`, alt);
      imageIds.push(id);
      imageAlts.set(id, alt);
      ids.push(id);
    }
    artCache.set(key, ids);
    return ids;
  };

  const colorOption = options.find((o) => o.type === 'swatch');
  const variantRows: Array<{ id: string; sku: string; options: Record<string, string>; price: number; salePrice: number | null; stock: number; imageIds: string[] }> = [];

  for (const [i, combo] of combos(options).entries()) {
    const art = { ...src.art, ...(src.artFor?.(combo) ?? {}) };
    const colorLabel = colorOption ? (colorOption.values.find((v) => v.id === combo[colorOption.id])?.label.en ?? null) : null;
    const ids = await addArt(art, colorLabel, i === 0 ? [0, 1, 2] : [0]);
    const pricing = src.priceFor?.(combo) ?? { price: src.price, salePrice: src.salePrice };
    const values = options.map((o) => combo[o.id]);
    // Stored with the SAME prefixed ids as the ProductOption/ProductOptionValue rows below
    // (`${src.id}__${optionId}` / `${src.id}__${optionId}__${valueId}`), because the admin UI matches a
    // variant to its option values by looking up `variant.options[option.id]` against those stored ids.
    const prefixedCombo = Object.fromEntries(
      Object.entries(combo).map(([optId, valId]) => [`${src.id}__${optId}`, `${src.id}__${optId}__${valId}`]),
    );
    variantRows.push({
      id: `${src.id}--${values.join('-') || 'default'}`,
      sku: `YS-${src.id.replace('p-', '').toUpperCase()}${values.length ? `-${values.join('-').toUpperCase()}` : ''}`,
      options: prefixedCombo,
      price: pricing.price,
      salePrice: pricing.salePrice ?? null,
      stock: typeof src.stock === 'number' ? src.stock : src.stock(combo),
      imageIds: colorOption ? ids : [],
    });
  }

  const phys = PHYSICAL[src.id] ?? { l: null, w: null, h: null, g: null };
  const createdAt = new Date(`${src.createdAt}T09:00:00Z`);

  await prisma.$transaction(async (tx) => {
    if (existing) {
      await tx.productImage.deleteMany({ where: { productId: src.id } });
      await tx.productOption.deleteMany({ where: { productId: src.id } });
      await tx.productVariant.deleteMany({ where: { productId: src.id } });
      await tx.productSpec.deleteMany({ where: { productId: src.id } });
    }

    const scalars = {
      slug: src.slug,
      status: 'active',
      nameEn: name.en,
      nameHi: name.hi,
      shortDescriptionEn: src.shortDescription.en,
      shortDescriptionHi: src.shortDescription.hi ?? '',
      descriptionEn: src.description.en,
      descriptionHi: src.description.hi ?? '',
      categoryId: src.categoryId,
      tags: JSON.stringify(src.tags),
      nameSearch: name.en.toLowerCase(),
      searchText: [name.en, name.hi, src.slug, src.tags.join(' '), variantRows.map((v) => v.sku).join(' ')]
        .filter(Boolean)
        .join(' ')
        .toLowerCase(),
      basePrice: src.price,
      baseSalePrice: src.salePrice ?? null,
      materialsEn: src.materials.en,
      materialsHi: src.materials.hi ?? '',
      careEn: src.care.en,
      careHi: src.care.hi ?? '',
      weightValue: phys.g,
      weightUnit: 'g',
      dimLength: phys.l,
      dimWidth: phys.w,
      dimHeight: phys.h,
      dimUnit: 'cm',
      isFeatured: !!src.isFeatured,
      isBestseller: !!src.isBestseller,
      isNew: !!src.isNew,
      displayOrder: Math.round(src.featuredRank * 10),
      seoTitleEn: `${name.en} — Handmade | Your Store`.slice(0, 70),
      seoTitleHi: '',
      seoDescriptionEn: (src.shortDescription.en ?? '').slice(0, 160),
      seoDescriptionHi: '',
      createdAt,
    };

    await tx.product.upsert({ where: { id: src.id }, update: scalars, create: { id: src.id, ...scalars } });

    await tx.productImage.createMany({
      data: imageIds.map((mediaId, position) => ({
        productId: src.id,
        mediaId,
        position,
        altEn: imageAlts.get(mediaId)?.en ?? '',
        altHi: imageAlts.get(mediaId)?.hi ?? '',
      })),
    });

    for (const [position, o] of options.entries()) {
      await tx.productOption.create({
        data: {
          id: `${src.id}__${o.id}`,
          productId: src.id,
          nameEn: o.name.en,
          nameHi: o.name.hi ?? '',
          type: o.type,
          position,
          values: {
            create: o.values.map((v, vPos) => ({
              id: `${src.id}__${o.id}__${v.id}`,
              labelEn: v.label.en,
              labelHi: v.label.hi ?? '',
              swatch: v.swatch ?? null,
              position: vPos,
            })),
          },
        },
      });
    }

    await tx.productVariant.createMany({
      data: variantRows.map((v, position) => ({
        ...v,
        options: JSON.stringify(v.options),
        imageIds: JSON.stringify(v.imageIds),
        productId: src.id,
        position,
      })),
    });

    const specs = phys.specs ?? [];
    if (specs.length) {
      await tx.productSpec.createMany({
        data: specs.map(([en, hi, value], position) => ({
          id: `${src.id}__spec__${position}`,
          productId: src.id,
          labelEn: en,
          labelHi: hi,
          valueEn: value,
          valueHi: value,
          position,
        })),
      });
    }
  });

  return true;
}

async function seedSettings() {
  const existingStore = await prisma.storeSettings.findUnique({ where: { id: 'singleton' } });
  if (existingStore && !FORCE) {
    console.log('  settings   already present (set SEED_FORCE=1 to overwrite)');
    return;
  }

  await prisma.storeSettings.upsert({
    where: { id: 'singleton' },
    create: {
      id: 'singleton',
      nameEn: 'Your Store',
      taglineEn: 'Handmade goods, made to last.',
      taglineHi: '',
      contactEmail: 'hello@yourstore.example',
      contactPhone: '+91 98765 43210',
      contactAddress: 'Jaipur, Rajasthan, India',
      contactHoursEn: 'Mon–Sat, 10am–6pm IST',
      contactHoursHi: '',
      handlingMinDays: 1,
      handlingMaxDays: 3,
      maxQtyPerLine: 10,
      lowStockThreshold: 5,
    },
    update: {},
  });

  // Shipping: one zone per ShippingZoneId, seeded from the illustrative SHIPPING_ZONES rates/times,
  // populated with every country currently assigned to that zone in src/countries.ts.
  await prisma.shippingSettings.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', unsupportedMessageEn: "We don't currently ship to this destination.", unsupportedMessageHi: '' },
    update: {},
  });
  if ((await prisma.shippingZone.count({ where: { settingsId: 'singleton' } })) === 0) {
    const zoneIds = Array.from(new Set(COUNTRIES.map((c) => c.zone).filter((z): z is ShippingZoneId => z !== null)));
    await prisma.shippingZone.createMany({
      data: zoneIds.map((zoneId, position) => {
        const countries = COUNTRIES.filter((c) => c.zone === zoneId).map((c) => c.code);
        const rates = SHIPPING_ZONES[zoneId];
        return {
          settingsId: 'singleton',
          nameEn: ZONE_NAME(zoneId),
          countries: JSON.stringify(countries),
          standardEnabled: true,
          standardRate: rates.standard.price,
          standardMinDays: rates.standard.minDays,
          standardMaxDays: rates.standard.maxDays,
          expressEnabled: true,
          expressRate: rates.express.price,
          expressMinDays: rates.express.minDays,
          expressMaxDays: rates.express.maxDays,
          position,
        };
      }),
    });
  }

  // Tax: one rule per shippable country, using its illustrative demoTaxRate converted to a percentage.
  await prisma.taxSettings.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', pricesIncludeTax: false, defaultRate: 0 },
    update: {},
  });
  if ((await prisma.taxRule.count({ where: { settingsId: 'singleton' } })) === 0) {
    const shippable = COUNTRIES.filter((c) => c.zone !== null);
    await prisma.taxRule.createMany({
      data: shippable.map((c) => ({
        settingsId: 'singleton',
        country: c.code,
        region: '',
        rate: Math.round(c.demoTaxRate * 10000) / 100,
        label: `${c.name} estimated tax`,
      })),
    });
  }

  // Currencies: the four the apps already ship, same illustrative rates as frontend/src/data/currencies.ts.
  await prisma.currencySettings.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', base: 'USD' }, update: {} });
  if ((await prisma.currencyConfig.count({ where: { settingsId: 'singleton' } })) === 0) {
    await prisma.currencyConfig.createMany({
      data: [
        { settingsId: 'singleton', code: 'USD', name: 'US Dollar', enabled: true, rate: 1, fractionDigits: 2, roundingIncrement: 1 },
        { settingsId: 'singleton', code: 'INR', name: 'Indian Rupee', enabled: true, rate: 84, fractionDigits: 0, roundingIncrement: 100 },
        { settingsId: 'singleton', code: 'EUR', name: 'Euro', enabled: true, rate: 0.92, fractionDigits: 2, roundingIncrement: 1 },
        { settingsId: 'singleton', code: 'GBP', name: 'British Pound', enabled: true, rate: 0.78, fractionDigits: 2, roundingIncrement: 1 },
      ],
    });
  }

  await prisma.languageSettings.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', defaultLanguage: 'en', hindiEnabled: true }, update: {} });

  console.log('  settings   store/shipping/tax/currencies/languages seeded');
}

// Same curated sets the storefront already displays today (the 7/4/4 products that carry
// isFeatured/isBestseller/isNew), pinned into HomepageContent as an explicit admin-editable list
// instead of a live flag filter — so publishing a new homepage selection takes effect without
// touching the underlying products.
const HOMEPAGE_FEATURED = ['p-mug', 'p-market-bag', 'p-vase', 'p-crossbody', 'p-leaf-necklace', 'p-candle', 'p-lamp'];
const HOMEPAGE_BESTSELLERS = ['p-mug', 'p-market-bag', 'p-leaf-necklace', 'p-bowl'];
const HOMEPAGE_NEW_ARRIVALS = ['p-planter', 'p-print-pouch', 'p-moonstone-ring', 'p-plates'];

async function seedContent() {
  const existingHomepage = await prisma.homepageContent.findUnique({ where: { id: 'singleton' } });
  if (existingHomepage && !FORCE) {
    console.log('  content    already present (set SEED_FORCE=1 to overwrite)');
    return;
  }

  const heroImageId = await upsertMedia(
    'm_homepage_hero',
    compositeArt(
      1600,
      760,
      [
        { spec: { kind: 'vase', color: '#ede6d8', accent: '#2f4a7a', seed: 'hero' }, x: 1000, baseY: 600, scale: 0.92 },
        { spec: { kind: 'mug', color: '#e6d3b8', seed: 'hero' }, x: 1220, baseY: 612, scale: 1.0 },
        { spec: { kind: 'basketBag', color: '#d2ae72', accent: '#8a5530', seed: 'hero' }, x: 1420, baseY: 616, scale: 0.7 },
      ],
      'warm',
      560,
    ),
    'homepage-hero.svg',
    L('Handmade ceramics and bags styled on a wooden table', ''),
    1600,
    760,
  );
  const storyImageId = await upsertMedia(
    'm_homepage_story',
    compositeArt(
      1200,
      900,
      [
        { spec: { kind: 'planter', color: '#c46a43', seed: 'story' }, x: 330, baseY: 730, scale: 0.85 },
        { spec: { kind: 'vase', color: '#e9dfcc', accent: '#6f7d5c', seed: 'story' }, x: 640, baseY: 740, scale: 0.8 },
        { spec: { kind: 'bowl', color: '#e9dfcc', seed: 'story' }, x: 900, baseY: 742, scale: 0.6 },
      ],
      'sage',
      700,
    ),
    'homepage-story.svg',
    L('The studio workbench with tools and works in progress', ''),
    1200,
    900,
  );

  const homepage = {
    announcement: {
      enabled: true,
      // No WELCOME10 (or any other) coupon is seeded, so the announcement must not advertise one — a
      // security/content audit found the two had drifted apart (this text, but no matching Coupon
      // row). If a demo coupon is wanted again, create it via POST /api/admin/coupons first, then
      // reference its real code here.
      text: L('Demo store · Currency rates are illustrative', ''),
    },
    hero: {
      title: L('Thoughtfully made. Yours to love.', ''),
      subtitle: L(
        'Handmade ceramics, bags, jewellery and home pieces from one small studio — for a brighter, more beautiful everyday.',
        '',
      ),
      imageId: heroImageId,
      ctaLabel: L('Shop collection', ''),
      ctaHref: '/shop',
    },
    featuredCategoryIds: CATEGORY_SOURCES.map((c) => c.id),
    featuredProductIds: HOMEPAGE_FEATURED,
    bestsellerProductIds: HOMEPAGE_BESTSELLERS,
    newArrivalProductIds: HOMEPAGE_NEW_ARRIVALS,
    itemsProductIds: [],
    transferProductIds: [],
    story: {
      title: L('Made slowly, by hand, in one small studio', ''),
      body: L(
        'Your Store is a single-maker studio. Every mug is thrown on the wheel, every bag is stitched and every pendant is cut by hand — in small batches, so nothing is wasted. We work with natural materials and local suppliers wherever we can, and we pack every order in plastic-free packaging.',
        '',
      ),
      imageId: storyImageId,
      ctaLabel: L('Read more about us', ''),
      ctaHref: '/about',
    },
    newsletter: {
      title: L('Letters from the studio', ''),
      body: L(
        'New collections, behind-the-scenes notes and first access to restocks. No spam.',
        '',
      ),
    },
  };
  // The homepage hero/announcement references sample categories and products, so it's sample content too.
  if (SEED_SAMPLE_CATALOG) {
    const homepageJson = JSON.stringify(homepage);
    await prisma.homepageContent.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', draftJson: homepageJson, publishedJson: homepageJson, publishedAt: new Date(), updatedBy: 'seed' },
      update: { draftJson: homepageJson, publishedJson: homepageJson, publishedAt: new Date(), updatedBy: 'seed' },
    });
  } else {
    console.log('  homepage   skipped (set SEED_SAMPLE_CATALOG=1 to seed sample homepage content)');
  }

  const section = (en: string, hi: string, bodyEn: string, bodyHi = '') => ({ id: en.toLowerCase().replace(/[^a-z0-9]+/g, '-'), heading: L(en, hi), body: L(bodyEn, bodyHi) });

  const pages: Record<string, { isLegal: boolean; content: unknown }> = {
    about: {
      isLegal: false,
      content: {
        title: L('About Your Store', ''),
        intro: L(
          'Your Store is a one-person studio making ceramics, bags, jewellery and home pieces by hand. This page is placeholder copy you can replace with your own story.',
          '',
        ),
        sections: [
          section('The studio', '', 'A small workshop where every piece is made by hand, in small batches.', ''),
          section('How things are made', '', 'Ceramics are wheel-thrown, bags are stitched and jewellery is hand-finished.', ''),
          section('Materials', '', 'Natural materials and local suppliers wherever possible.', ''),
        ],
      },
    },
    contact: {
      isLegal: false,
      content: {
        title: L('Get in touch', ''),
        intro: L('Questions about an order, a product or anything else — we read every message.', ''),
        sections: [],
      },
    },
    faq: {
      isLegal: false,
      content: {
        title: L('Frequently asked questions', ''),
        intro: L('Answers to the questions we hear most often.', ''),
        sections: [
          section('How long does shipping take?', '', 'Domestic orders arrive in 3–6 business days; international orders vary by destination — see our shipping page.', ''),
          section('Can I return an item?', '', 'Yes, within our return window — see our returns page for details.', ''),
          section('Are these items handmade?', '', 'Every piece is made by hand in small batches, so small variations are part of the character.', ''),
          section('Do you ship internationally?', '', 'Yes, to many countries — check the shipping page for current destinations and rates.', ''),
          section('How do I care for ceramics?', '', 'Hand wash is recommended to keep glazes looking their best.', ''),
          section('What payment methods do you accept?', '', 'Cash on delivery is always available; card and other online methods are added as they become available.', ''),
          section('Can I change my order after placing it?', '', 'Contact us as soon as possible — we can usually help before an order ships.', ''),
          section('How do I track my order?', '', 'Use the order tracking page with your order number and email.', ''),
        ],
      },
    },
    shipping: {
      isLegal: false,
      content: {
        title: L('Shipping information', ''),
        intro: L('Where we ship, how long it takes, and what to expect at checkout.', ''),
        sections: [
          section('Processing time', '', 'Orders are prepared within 1–3 business days before they ship.', ''),
          section('Customs and duties', '', 'International orders may be subject to customs fees charged by your country on arrival.', ''),
          section('Tracking', '', 'A tracking number is added to your order once it ships.', ''),
          section("Destinations we don't serve yet", '', "We're adding new destinations over time — check back if yours isn't listed yet.", ''),
        ],
      },
    },
    returns: {
      isLegal: true,
      content: {
        title: L('Returns & exchanges', ''),
        intro: L('Our return policy for handmade goods.', ''),
        sections: [
          section('Return window', '', 'Items can be returned within 14 days of delivery, unused and in original packaging.', ''),
          section("Items that can't be returned", '', 'Made-to-order and personalised items cannot be returned unless faulty.', ''),
          section('Damaged or faulty items', '', 'Contact us with photos within 48 hours of delivery for a replacement or refund.', ''),
          section('Refunds', '', 'Refunds are issued to the original payment method once a return is received.', ''),
        ],
      },
    },
    privacy: {
      isLegal: true,
      content: {
        title: L('Privacy policy', ''),
        intro: L('How we collect, use and protect your information.', ''),
        sections: [
          section('Information we collect', '', 'Name, contact details and order history needed to fulfil your order.', ''),
          section('How we use it', '', 'To process orders, respond to enquiries and improve the store.', ''),
          section('Sharing', '', 'We do not sell your information. It is shared only with services needed to deliver your order.', ''),
          section('Your rights', '', 'Contact us to access, correct or delete the information we hold about you.', ''),
        ],
      },
    },
    terms: {
      isLegal: true,
      content: {
        title: L('Terms of service', ''),
        intro: L('The terms that apply when you shop with us.', ''),
        sections: [
          section('Orders', '', 'Placing an order is an offer to buy, which we accept when we confirm your order.', ''),
          section('Pricing', '', 'Prices are shown in your selected currency using an illustrative conversion rate.', ''),
          section('Handmade variation', '', 'Small variations in colour, size and finish are part of handmade items, not defects.', ''),
          section('Liability', '', 'We are not liable for indirect or consequential loss arising from use of this site.', ''),
          section('Changes', '', 'We may update these terms from time to time; continued use means you accept the changes.', ''),
        ],
      },
    },
  };

  for (const [key, { isLegal, content }] of Object.entries(pages)) {
    const json = JSON.stringify(content);
    await prisma.pageDoc.upsert({
      where: { key },
      create: { key, isLegal, draftJson: json, publishedJson: json, publishedAt: new Date(), updatedBy: 'seed' },
      update: { draftJson: json, publishedJson: json, publishedAt: new Date(), updatedBy: 'seed' },
    });
  }

  console.log('  content    homepage + 7 pages seeded and published');
}

async function main() {
  console.log('Seeding Your Store…');
  await seedOwner();

  if (SEED_DEMO_CUSTOMER) {
    await seedDemoCustomer();
  } else {
    console.log('  customer   skipped (set SEED_DEMO_CUSTOMER=1 to create the demo shopper account)');
  }

  await seedSettings();
  await seedContent();

  if (!SEED_SAMPLE_CATALOG) {
    console.log('  catalog    skipped (set SEED_SAMPLE_CATALOG=1 to seed sample categories/products/nav/collections)');
    console.log('Done.');
    return;
  }

  await seedCategories();

  let created = 0;
  let skipped = 0;
  for (const src of PRODUCT_SOURCES) {
    (await seedProduct(src)) ? created++ : skipped++;
  }
  console.log(`  products   ${created} written, ${skipped} already present${FORCE ? '' : ' (set SEED_FORCE=1 to overwrite)'}`);

  await seedNavAndCollections();

  const [products, variants, media] = await Promise.all([prisma.product.count(), prisma.productVariant.count(), prisma.media.count()]);
  console.log(`Done. ${products} products, ${variants} variants, ${media} images.`);
}

/** Secondary nav row + two example collections (a Wedding-Guide-style landing page with a hero and
 *  several sections, and a Top-Gifts-style curated listing with one flat section) — illustrative demo
 *  content the owner edits via the admin Collections/Navigation screens. */
async function seedNavAndCollections() {
  if ((await prisma.navLink.count()) === 0) {
    await prisma.navLink.createMany({
      data: [
        { labelEn: 'Gifts', labelHi: '', href: '/category/jewellery', position: 0 },
        { labelEn: 'Top Gifts', labelHi: '', href: '/collection/top-gifts', position: 1 },
        { labelEn: 'Home Favourites', labelHi: '', href: '/category/home-decor', position: 2 },
        { labelEn: 'Wedding Guide', labelHi: '', href: '/collection/wedding-guide', position: 3 },
      ],
    });
    console.log('  nav links  4 seeded');
  }

  const haveProducts = async (ids: string[]) => {
    const found = await prisma.product.findMany({ where: { id: { in: ids } }, select: { id: true } });
    return ids.filter((id) => found.some((f) => f.id === id));
  };

  if (!(await prisma.collection.findUnique({ where: { slug: 'wedding-guide' } }))) {
    const winter = await haveProducts(['p-candle', 'p-vase', 'p-teapot', 'p-cushion']);
    const heritage = await haveProducts(['p-leaf-necklace', 'p-bracelet', 'p-hoops', 'p-jhumka']);
    await prisma.collection.create({
      data: {
        id: 'col-wedding-guide',
        slug: 'wedding-guide',
        titleEn: 'Wedding Guide',
        titleHi: '',
        subtitleEn: 'Handmade pieces for every part of the celebration.',
        subtitleHi: '',
        heroColor: '#F3E6DC',
        status: 'published',
        publishedAt: new Date(),
        displayOrder: 0,
        circles: { create: [
          { labelEn: 'Ceramics', labelHi: '', linkType: 'category', linkValue: 'ceramics', position: 0 },
          { labelEn: 'Jewellery', labelHi: '', linkType: 'category', linkValue: 'jewellery', position: 1 },
          { labelEn: 'Home Decor', labelHi: '', linkType: 'category', linkValue: 'home-decor', position: 2 },
        ] },
        sections: { create: [
          { titleEn: 'Winter Wedding', titleHi: '', position: 0, productIds: JSON.stringify(winter) },
          { titleEn: 'Heritage Wedding', titleHi: '', position: 1, productIds: JSON.stringify(heritage) },
        ] },
      },
    });
    console.log('  collection wedding-guide seeded');
  }

  if (!(await prisma.collection.findUnique({ where: { slug: 'top-gifts' } }))) {
    const gifts = await haveProducts(['p-mug', 'p-bowl', 'p-planter', 'p-print-pouch', 'p-moonstone-ring', 'p-plates']);
    await prisma.collection.create({
      data: {
        id: 'col-top-gifts',
        slug: 'top-gifts',
        titleEn: 'Top Gifts',
        titleHi: '',
        subtitleEn: 'Festive finds for everyone.',
        subtitleHi: '',
        heroColor: '#EFE9DE',
        status: 'published',
        publishedAt: new Date(),
        displayOrder: 1,
        sections: { create: [{ titleEn: 'Top Gifts', titleHi: '', position: 0, productIds: JSON.stringify(gifts) }] },
      },
    });
    console.log('  collection top-gifts seeded');
  }
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
