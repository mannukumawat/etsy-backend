// Catalogue source copied from admin/src/data/catalogSource.ts (itself copied from the storefront) so the admin seed uses the same product ids,
// slugs, SKUs, prices, stock and copy as the storefront. Independent copy — no cross-project imports.
// The admin seed (data/seed.ts) converts these into admin Product records and media assets.

import type { ArtSpec } from './art.js';

export type SourceLocalized = { en: string; hi?: string };
type Combo = Record<string, string>;

export interface SourceOption {
  id: string;
  name: SourceLocalized;
  type: 'swatch' | 'button';
  values: Array<{ id: string; label: SourceLocalized; swatch?: string }>;
}

export interface ProductSource {
  id: string;
  slug: string;
  categoryId: string;
  name: SourceLocalized;
  shortDescription: SourceLocalized;
  description: SourceLocalized;
  materials: SourceLocalized;
  care: SourceLocalized;
  dimensions: Array<{ key: string; value: string }>;
  price: number;
  salePrice?: number;
  art: ArtSpec;
  artFor?: (combo: Combo) => Partial<ArtSpec>;
  options?: SourceOption[];
  priceFor?: (combo: Combo) => { price: number; salePrice?: number };
  stock: number | ((combo: Combo) => number);
  reviews: Array<[string, string, number, string, string, string]>;
  tags: string[];
  isFeatured?: boolean;
  isBestseller?: boolean;
  isNew?: boolean;
  createdAt: string;
  featuredRank: number;
}

const opt = {
  color: (values: SourceOption['values']): SourceOption => ({ id: 'color', name: { en: 'Colour', hi: '' }, type: 'swatch', values }),
  size: (values: SourceOption['values']): SourceOption => ({ id: 'size', name: { en: 'Size', hi: '' }, type: 'button', values }),
};

const v = (id: string, en: string, hi: string, swatch?: string) => ({ id, label: { en, hi }, swatch });

const CERAMIC_CARE: SourceLocalized = {
  en: 'Dishwasher and microwave safe. Avoid sudden temperature changes. Each piece is handmade, so small variations in glaze and speckling are part of its character.',
  hi: '',
};

const JEWELLERY_CARE: SourceLocalized = {
  en: 'Store in the cotton pouch provided. Remove before swimming or bathing. Polish gently with a soft dry cloth.',
  hi: '',
};

export const PRODUCT_SOURCES: ProductSource[] = [
  // ---------------- CERAMICS ----------------
  {
    id: 'p-mug',
    slug: 'everyday-speckled-mug',
    categoryId: 'ceramics',
    name: { en: 'Everyday Speckled Mug', hi: '' },
    shortDescription: {
      en: 'A wheel-thrown stoneware mug with a soft speckled glaze.',
      hi: '',
    },
    description: {
      en: 'Start your day a little slower. This everyday mug is wheel-thrown, trimmed and glazed by hand, leaving the foot unglazed so you can feel the clay. The generous handle fits three fingers comfortably.',
      hi: '',
    },
    materials: { en: 'Stoneware clay, lead-free food-safe glaze', hi: '' },
    care: CERAMIC_CARE,
    dimensions: [
      { key: 'height', value: '9.5 cm (3.7 in)' },
      { key: 'diameter', value: '8.5 cm (3.3 in)' },
      { key: 'capacity', value: '320 ml (11 oz)' },
    ],
    price: 2800,
    art: { kind: 'mug', color: '#e6d3b8' },
    options: [
      opt.color([
        v('sand', 'Sand', '', '#e6d3b8'),
        v('sage', 'Sage', '', '#a9b49a'),
        v('blush', 'Blush', '', '#e3b9a8'),
        v('charcoal', 'Charcoal', '', '#4a4542'),
      ]),
    ],
    artFor: (c) => ({ color: { sand: '#e6d3b8', sage: '#a9b49a', blush: '#e3b9a8', charcoal: '#4a4542' }[c.color] }),
    stock: (c) => ({ sand: 24, sage: 12, blush: 3, charcoal: 0 })[c.color] ?? 0,
    reviews: [
      ['Asha K.', 'Pune, IN', 5, '2026-08-14', 'My new favourite mug', 'Lovely weight and the handle is really comfortable. The sand colour is warmer in person.'],
      ['Tom R.', 'Leeds, UK', 4, '2026-07-02', 'Beautiful, slightly smaller than expected', 'Gorgeous glaze. Holds a regular coffee but not a giant one — check the capacity.'],
      ['Meera S.', 'Bengaluru, IN', 5, '2026-06-21', 'Bought two more', 'Survived the dishwasher for months with no change to the glaze.'],
      ['Lena W.', 'Berlin, DE', 4, '2026-05-30', 'Well packed', 'Arrived safely and looks handmade in the best way.'],
    ],
    tags: ['mug', 'coffee', 'tea', 'stoneware', 'gift'],
    isFeatured: true,
    isBestseller: true,
    createdAt: '2026-03-10',
    featuredRank: 1,
  },
  {
    id: 'p-bowl',
    slug: 'stoneware-breakfast-bowl',
    categoryId: 'ceramics',
    name: { en: 'Stoneware Breakfast Bowl', hi: '' },
    shortDescription: { en: 'A deep, generous bowl for oats, noodles and salads.', hi: '' },
    description: {
      en: 'Thrown a little deeper than a cereal bowl, with an iron-brown rim that catches the light. It stacks neatly and works as well for a weekday breakfast as for a dinner-party side.',
      hi: '',
    },
    materials: { en: 'Stoneware clay, satin glaze with iron oxide rim', hi: '' },
    care: CERAMIC_CARE,
    dimensions: [
      { key: 'diameter', value: '15 cm (5.9 in)' },
      { key: 'height', value: '7 cm (2.8 in)' },
      { key: 'capacity', value: '600 ml (20 oz)' },
    ],
    price: 3200,
    salePrice: 2600,
    art: { kind: 'bowl', color: '#e9dfcc' },
    options: [opt.color([v('oat', 'Oat', '', '#e9dfcc'), v('ocean', 'Ocean', '', '#6e8fa3')])],
    artFor: (c) => ({ color: c.color === 'ocean' ? '#6e8fa3' : '#e9dfcc' }),
    stock: (c) => (c.color === 'oat' ? 18 : 9),
    reviews: [
      ['Priya N.', 'Mumbai, IN', 5, '2026-09-02', 'Perfect size', 'Exactly the bowl I wanted for ramen nights.'],
      ['Jules M.', 'Lyon, FR', 5, '2026-08-11', 'Superbe', 'The ocean glaze has lovely depth. Very happy.'],
      ['Sam P.', 'Austin, US', 4, '2026-06-18', 'Great bowl', 'Slight wobble on one, but that is handmade life. Would buy again.'],
    ],
    tags: ['bowl', 'tableware', 'stoneware', 'sale'],
    isBestseller: true,
    createdAt: '2026-02-20',
    featuredRank: 6,
  },
  {
    id: 'p-vase',
    slug: 'hand-painted-bud-vase',
    categoryId: 'ceramics',
    name: { en: 'Hand-painted Bud Vase', hi: '' },
    shortDescription: { en: 'A small vase brushed with indigo leaf motifs.', hi: '' },
    description: {
      en: 'Each vase is painted freehand with an indigo leaf border, so no two are quite the same. Made for a single stem, a sprig of olive or a handful of dried grasses.',
      hi: '',
    },
    materials: { en: 'Stoneware, cobalt underglaze, clear glaze', hi: '' },
    care: {
      en: 'Watertight. Hand wash recommended to protect the painted design.',
      hi: '',
    },
    dimensions: [
      { key: 'height', value: '16 cm (6.3 in)' },
      { key: 'diameter', value: '11 cm (4.3 in)' },
    ],
    price: 4800,
    art: { kind: 'vase', color: '#ede6d8', accent: '#2f4a7a' },
    stock: 4,
    reviews: [
      ['Hannah L.', 'Dublin, IE', 5, '2026-07-19', 'Even prettier in person', 'The brushwork is delicate and the indigo is rich.'],
      ['Ravi T.', 'Jaipur, IN', 5, '2026-05-08', 'Gift hit', 'Bought it for my mother — she has it on the dining table.'],
    ],
    tags: ['vase', 'flowers', 'painted', 'gift'],
    isFeatured: true,
    createdAt: '2026-04-02',
    featuredRank: 3,
  },
  {
    id: 'p-plates',
    slug: 'ceramic-dinner-plate-set',
    categoryId: 'ceramics',
    name: { en: 'Ceramic Dinner Plate Set', hi: '' },
    shortDescription: { en: 'Wide-rimmed dinner plates in a warm oat glaze.', hi: '' },
    description: {
      en: 'Rolled slabs shaped over a wooden form and finished with a speckled oat glaze. Sold as a set of two or four for everyday family meals.',
      hi: '',
    },
    materials: { en: 'Stoneware clay, food-safe satin glaze', hi: '' },
    care: CERAMIC_CARE,
    dimensions: [
      { key: 'diameter', value: '27 cm (10.6 in)' },
      { key: 'height', value: '2.5 cm (1 in)' },
    ],
    price: 6400,
    art: { kind: 'plates', color: '#e8dcc8' },
    options: [opt.size([v('set2', 'Set of 2', ''), v('set4', 'Set of 4', '')])],
    priceFor: (c) => ({ price: c.size === 'set4' ? 11800 : 6400 }),
    stock: (c) => (c.size === 'set2' ? 10 : 0),
    reviews: [['Claire D.', 'Toronto, CA', 5, '2026-10-05', 'Restaurant-worthy', 'Food looks beautiful on these. Rims are wide and practical.']],
    tags: ['plate', 'tableware', 'dinner', 'set'],
    isNew: true,
    createdAt: '2026-10-01',
    featuredRank: 9,
  },
  {
    id: 'p-teapot',
    slug: 'glazed-stoneware-teapot',
    categoryId: 'ceramics',
    name: { en: 'Glazed Stoneware Teapot', hi: '' },
    shortDescription: { en: 'A round-bellied teapot that pours without dripping.', hi: '' },
    description: {
      en: 'A full-bodied teapot with a pulled handle and a carefully cut spout. Holds four cups. Currently sold out — new batches are fired every few weeks.',
      hi: '',
    },
    materials: { en: 'Stoneware, food-safe glaze, stainless steel infuser', hi: '' },
    care: CERAMIC_CARE,
    dimensions: [
      { key: 'height', value: '15 cm (5.9 in)' },
      { key: 'width', value: '24 cm (9.4 in)' },
      { key: 'capacity', value: '900 ml (30 oz)' },
    ],
    price: 6800,
    art: { kind: 'teapot', color: '#efe6d6' },
    options: [opt.color([v('cream', 'Cream', '', '#efe6d6'), v('celadon', 'Celadon', '', '#b5c4b1')])],
    artFor: (c) => ({ color: c.color === 'celadon' ? '#b5c4b1' : '#efe6d6' }),
    stock: 0,
    reviews: [
      ['Yuki A.', 'Osaka, JP', 5, '2026-04-12', 'Pours beautifully', 'No drips at all. The celadon is calm and lovely.'],
      ['Nina F.', 'Amsterdam, NL', 4, '2026-03-28', 'Lovely but heavy', 'Solid and well made; a bit heavy when full.'],
    ],
    tags: ['teapot', 'tea', 'stoneware'],
    createdAt: '2026-01-15',
    featuredRank: 14,
  },

  // ---------------- BAGS ----------------
  {
    id: 'p-market-bag',
    slug: 'woven-market-basket-bag',
    categoryId: 'bags',
    name: { en: 'Woven Market Basket Bag', hi: '' },
    shortDescription: { en: 'A sturdy palm-leaf basket with leather handles.', hi: '' },
    description: {
      en: 'Tightly woven from sun-dried palm leaf and finished with vegetable-tanned leather handles. Big enough for a market haul or a day at the beach.',
      hi: '',
    },
    materials: { en: 'Palm leaf, vegetable-tanned leather, brass rivets', hi: '' },
    care: { en: 'Spot clean with a damp cloth and air dry away from direct heat.', hi: '' },
    dimensions: [
      { key: 'height', value: '32 cm (12.6 in)' },
      { key: 'width', value: '40 cm (15.7 in)' },
      { key: 'depth', value: '18 cm (7.1 in)' },
    ],
    price: 6800,
    art: { kind: 'basketBag', color: '#d2ae72', accent: '#8a5530' },
    options: [opt.size([v('m', 'Medium', ''), v('l', 'Large', '')])],
    priceFor: (c) => ({ price: c.size === 'l' ? 8200 : 6800 }),
    stock: (c) => (c.size === 'm' ? 14 : 6),
    reviews: [
      ['Sofia G.', 'Madrid, ES', 5, '2026-07-07', 'Carries everything', 'Took it to the market every weekend this summer. Still looks new.'],
      ['Anjali R.', 'Kochi, IN', 5, '2026-06-01', 'Excellent weave', 'Very tight weave, handles are soft and strong.'],
      ['Ben H.', 'Sydney, AU', 4, '2026-04-22', 'Great bag', 'Large is really large — medium may suit most people.'],
    ],
    tags: ['bag', 'basket', 'market', 'summer'],
    isFeatured: true,
    isBestseller: true,
    createdAt: '2026-02-05',
    featuredRank: 2,
  },
  {
    id: 'p-canvas-tote',
    slug: 'everyday-canvas-tote',
    categoryId: 'bags',
    name: { en: 'Everyday Canvas Tote', hi: '' },
    shortDescription: { en: 'Heavy cotton canvas with an inside pocket.', hi: '' },
    description: {
      en: 'Cut and sewn from 12 oz cotton canvas dyed in small batches. Reinforced straps, a stitched front pocket and an inner slip pocket for keys.',
      hi: '',
    },
    materials: { en: '100% cotton canvas, low-impact dyes', hi: '' },
    care: { en: 'Machine wash cold, inside out. Line dry.', hi: '' },
    dimensions: [
      { key: 'height', value: '38 cm (15 in)' },
      { key: 'width', value: '36 cm (14.2 in)' },
      { key: 'length', value: 'Handle drop 28 cm (11 in)' },
    ],
    price: 3600,
    art: { kind: 'tote', color: '#e8dfcd' },
    options: [
      opt.color([v('natural', 'Natural', '', '#e8dfcd'), v('indigo', 'Indigo', '', '#3e4f72'), v('olive', 'Olive', '', '#7a7b4e')]),
    ],
    artFor: (c) => ({ color: { natural: '#e8dfcd', indigo: '#3e4f72', olive: '#7a7b4e' }[c.color] }),
    stock: (c) => ({ natural: 30, indigo: 22, olive: 2 })[c.color] ?? 0,
    reviews: [['Maya B.', 'Chennai, IN', 4, '2026-10-10', 'Simple and sturdy', 'Fits my laptop and lunch. Wish it had a zip, but love it.']],
    tags: ['bag', 'tote', 'cotton', 'everyday'],
    isNew: true,
    createdAt: '2026-09-22',
    featuredRank: 10,
  },
  {
    id: 'p-crossbody',
    slug: 'leather-crossbody-bag',
    categoryId: 'bags',
    name: { en: 'Leather Crossbody Bag', hi: '' },
    shortDescription: { en: 'A hand-stitched leather bag with a brass clasp.', hi: '' },
    description: {
      en: 'Saddle-stitched by hand from full-grain vegetable-tanned leather that softens and darkens with use. Adjustable strap, one inner pocket and a turn-lock brass clasp.',
      hi: '',
    },
    materials: { en: 'Full-grain vegetable-tanned leather, waxed linen thread, solid brass', hi: '' },
    care: { en: 'Condition every few months with leather balm. Keep away from prolonged rain.', hi: '' },
    dimensions: [
      { key: 'height', value: '17 cm (6.7 in)' },
      { key: 'width', value: '24 cm (9.4 in)' },
      { key: 'depth', value: '7 cm (2.8 in)' },
      { key: 'length', value: 'Strap 110–130 cm (43–51 in)' },
    ],
    price: 12400,
    salePrice: 9900,
    art: { kind: 'crossbody', color: '#a86b3c' },
    options: [opt.color([v('tan', 'Tan', '', '#a86b3c'), v('espresso', 'Espresso', '', '#5a3a26')])],
    artFor: (c) => ({ color: c.color === 'espresso' ? '#5a3a26' : '#a86b3c' }),
    stock: (c) => (c.color === 'tan' ? 7 : 5),
    reviews: [
      ['Olivia P.', 'London, UK', 5, '2026-09-15', 'Beautiful craftsmanship', 'The stitching is perfect and the leather smells wonderful.'],
      ['Karan V.', 'Delhi, IN', 5, '2026-08-03', 'Bought for my wife', 'She uses it every day. Great size for phone, wallet and keys.'],
      ['Emily J.', 'Boston, US', 4, '2026-06-26', 'Stiff at first', 'Took a couple of weeks to soften, now it is perfect.'],
    ],
    tags: ['bag', 'leather', 'crossbody', 'sale', 'gift'],
    isFeatured: true,
    createdAt: '2026-01-28',
    featuredRank: 4,
  },
  {
    id: 'p-jute-clutch',
    slug: 'jute-evening-clutch',
    categoryId: 'bags',
    name: { en: 'Jute Evening Clutch', hi: '' },
    shortDescription: { en: 'A fine-woven jute clutch with a silk tassel.', hi: '' },
    description: {
      en: 'Hand-loomed jute, lined in cotton and closed with a metal zip. The rust silk tassel makes it just a little bit festive.',
      hi: '',
    },
    materials: { en: 'Hand-loomed jute, cotton lining, silk tassel', hi: '' },
    care: { en: 'Spot clean only. Store flat.', hi: '' },
    dimensions: [
      { key: 'height', value: '14 cm (5.5 in)' },
      { key: 'width', value: '26 cm (10.2 in)' },
    ],
    price: 4200,
    art: { kind: 'clutch', color: '#c8a878', accent: '#b5452b', pattern: 'jute' },
    stock: 3,
    reviews: [['Fatima Z.', 'Dubai, AE', 4, '2026-05-17', 'Elegant', 'Perfect for weddings. Slightly smaller than my phone plus a wallet.']],
    tags: ['bag', 'clutch', 'jute', 'festive'],
    createdAt: '2026-03-30',
    featuredRank: 12,
  },
  {
    id: 'p-print-pouch',
    slug: 'block-print-zip-pouch',
    categoryId: 'bags',
    name: { en: 'Block-print Zip Pouch', hi: '' },
    shortDescription: { en: 'A hand block-printed cotton pouch for every little thing.', hi: '' },
    description: {
      en: 'Printed by hand with carved teak blocks, then lined and zipped. Use it for makeup, chargers or travel documents.',
      hi: '',
    },
    materials: { en: 'Cotton, natural-pigment inks, metal zip', hi: '' },
    care: { en: 'Hand wash cold separately; colours may bleed slightly at first.', hi: '' },
    dimensions: [
      { key: 'height', value: '15 cm (5.9 in)' },
      { key: 'width', value: '23 cm (9 in)' },
    ],
    price: 2200,
    art: { kind: 'clutch', color: '#f1e9da', accent: '#2f4a7a', pattern: 'print' },
    options: [opt.color([v('indigo', 'Indigo print', '', '#2f4a7a'), v('madder', 'Madder red', '', '#a8442e')])],
    artFor: (c) => ({ accent: c.color === 'madder' ? '#a8442e' : '#2f4a7a' }),
    stock: (c) => (c.color === 'indigo' ? 40 : 35),
    reviews: [],
    tags: ['pouch', 'block print', 'travel', 'gift'],
    isNew: true,
    createdAt: '2026-10-12',
    featuredRank: 15,
  },

  // ---------------- JEWELLERY ----------------
  {
    id: 'p-leaf-necklace',
    slug: 'brass-leaf-pendant-necklace',
    categoryId: 'jewellery',
    name: { en: 'Brass Leaf Pendant Necklace', hi: '' },
    shortDescription: { en: 'A hand-cut brass leaf on a fine chain.', hi: '' },
    description: {
      en: 'Each leaf is cut from brass sheet with a jeweller’s saw, veined with a chisel and polished to a soft glow. Choose the chain length that sits best for you.',
      hi: '',
    },
    materials: { en: 'Recycled brass pendant, brass chain, lobster clasp', hi: '' },
    care: JEWELLERY_CARE,
    dimensions: [
      { key: 'dropLength', value: 'Pendant 3.5 cm (1.4 in)' },
      { key: 'weight', value: '6 g' },
    ],
    price: 5400,
    art: { kind: 'necklace', color: '#c9a04f' },
    options: [
      {
        id: 'chain',
        name: { en: 'Chain length', hi: '' },
        type: 'button',
        values: [v('16', '16 in (41 cm)', ''), v('18', '18 in (46 cm)', ''), v('20', '20 in (51 cm)', '')],
      },
    ],
    stock: (c) => ({ '16': 8, '18': 12, '20': 0 })[c.chain] ?? 0,
    reviews: [
      ['Isha M.', 'Hyderabad, IN', 5, '2026-09-28', 'Delicate and lovely', 'I wear it every day. 18 inch sits just below the collarbone.'],
      ['Grace T.', 'Auckland, NZ', 5, '2026-08-19', 'So pretty', 'Arrived in a sweet cotton pouch. Great gift.'],
      ['Daniel K.', 'Chicago, US', 4, '2026-07-12', 'Nice weight', 'Lighter than expected, which is actually great for daily wear.'],
    ],
    tags: ['necklace', 'brass', 'pendant', 'gift'],
    isFeatured: true,
    isBestseller: true,
    createdAt: '2026-02-14',
    featuredRank: 5,
  },
  {
    id: 'p-hoops',
    slug: 'hammered-hoop-earrings',
    categoryId: 'jewellery',
    name: { en: 'Hammered Hoop Earrings', hi: '' },
    shortDescription: { en: 'Everyday hoops with a hand-hammered texture.', hi: '' },
    description: {
      en: 'Formed around a mandrel and hammered to catch the light from every angle. Lightweight enough to forget you are wearing them.',
      hi: '',
    },
    materials: { en: 'Brass or sterling silver, hypoallergenic ear wires', hi: '' },
    care: JEWELLERY_CARE,
    dimensions: [
      { key: 'diameter', value: '3 cm (1.2 in)' },
      { key: 'weight', value: '3 g per pair' },
    ],
    price: 3800,
    art: { kind: 'hoops', color: '#c9a04f' },
    options: [
      {
        id: 'finish',
        name: { en: 'Finish', hi: '' },
        type: 'swatch',
        values: [v('brass', 'Gold-tone brass', '', '#c9a04f'), v('silver', 'Sterling silver', '', '#b9bcc0')],
      },
    ],
    artFor: (c) => ({ color: c.finish === 'silver' ? '#b9bcc0' : '#c9a04f' }),
    priceFor: (c) => ({ price: c.finish === 'silver' ? 4600 : 3800 }),
    stock: (c) => (c.finish === 'brass' ? 20 : 6),
    reviews: [
      ['Zara H.', 'Manchester, UK', 5, '2026-09-09', 'Perfect everyday hoops', 'Silver ones are bright and comfortable.'],
      ['Nisha G.', 'Ahmedabad, IN', 4, '2026-08-27', 'Lovely texture', 'Brass darkens a bit over time; a quick polish fixes it.'],
      ['Leah S.', 'Melbourne, AU', 5, '2026-06-14', 'Light as air', 'Comfortable all day.'],
    ],
    tags: ['earrings', 'hoops', 'silver', 'brass'],
    isBestseller: true,
    createdAt: '2026-03-03',
    featuredRank: 7,
  },
  {
    id: 'p-moonstone-ring',
    slug: 'moonstone-stacking-ring',
    categoryId: 'jewellery',
    name: { en: 'Moonstone Stacking Ring', hi: '' },
    shortDescription: { en: 'A slim silver band set with a rainbow moonstone.', hi: '' },
    description: {
      en: 'A slim sterling silver band with a bezel-set rainbow moonstone that flashes blue in the light. Designed to stack — or wear on its own.',
      hi: '',
    },
    materials: { en: 'Sterling silver, natural rainbow moonstone (approx. 5 mm)', hi: '' },
    care: JEWELLERY_CARE,
    dimensions: [
      { key: 'width', value: 'Band 1.5 mm' },
      { key: 'diameter', value: 'Stone approx. 5 mm' },
    ],
    price: 4500,
    art: { kind: 'ring', color: '#bfc3c7' },
    options: [
      {
        id: 'size',
        name: { en: 'Ring size (US)', hi: '' },
        type: 'button',
        values: ['5', '6', '7', '8', '9'].map((s) => v(s, s, s)),
      },
    ],
    stock: (c) => ({ '5': 2, '6': 5, '7': 9, '8': 4, '9': 0 })[c.size] ?? 0,
    reviews: [['Ana C.', 'Lisbon, PT', 5, '2026-10-08', 'Magical stone', 'The blue flash is gorgeous. Sizing was accurate.']],
    tags: ['ring', 'moonstone', 'silver', 'stacking'],
    isNew: true,
    createdAt: '2026-10-05',
    featuredRank: 11,
  },
  {
    id: 'p-bracelet',
    slug: 'beaded-gemstone-bracelet',
    categoryId: 'jewellery',
    name: { en: 'Beaded Gemstone Bracelet', hi: '' },
    shortDescription: { en: 'Polished gemstone beads on a durable stretch cord.', hi: '' },
    description: {
      en: 'Hand-strung 8 mm gemstone beads with a single brass accent bead. Slips on easily and fits most wrists (16–18 cm).',
      hi: '',
    },
    materials: { en: 'Natural gemstone beads, brass bead, elastic cord', hi: '' },
    care: JEWELLERY_CARE,
    dimensions: [
      { key: 'diameter', value: 'Beads 8 mm' },
      { key: 'length', value: 'Fits 16–18 cm wrists' },
    ],
    price: 3400,
    salePrice: 2800,
    art: { kind: 'bracelet', color: '#e7b9b5' },
    options: [
      {
        id: 'stone',
        name: { en: 'Stone', hi: '' },
        type: 'swatch',
        values: [v('rose', 'Rose quartz', '', '#e7b9b5'), v('amazonite', 'Amazonite', '', '#8cc2b5'), v('tiger', 'Tiger’s eye', '', '#a86f2e')],
      },
    ],
    artFor: (c) => ({ color: { rose: '#e7b9b5', amazonite: '#8cc2b5', tiger: '#a86f2e' }[c.stone] }),
    stock: (c) => ({ rose: 15, amazonite: 11, tiger: 9 })[c.stone] ?? 0,
    reviews: [
      ['Pooja D.', 'Indore, IN', 4, '2026-07-30', 'Pretty colours', 'Rose quartz is soft pink and calming.'],
      ['Chloe B.', 'Paris, FR', 3, '2026-06-09', 'Nice but small', 'A little snug on my wrist — check the size guide.'],
    ],
    tags: ['bracelet', 'gemstone', 'beads', 'sale'],
    createdAt: '2026-04-18',
    featuredRank: 13,
  },
  {
    id: 'p-jhumka',
    slug: 'silver-filigree-jhumka-earrings',
    categoryId: 'jewellery',
    name: { en: 'Silver Filigree Jhumka Earrings', hi: '' },
    shortDescription: { en: 'Bell-shaped jhumkas with fine filigree and pearl drops.', hi: '' },
    description: {
      en: 'Traditional jhumkas worked in fine silver filigree, with a garnet-red centre and a fringe of freshwater pearls. Currently sold out.',
      hi: '',
    },
    materials: { en: 'Silver-plated brass filigree, glass garnet, freshwater pearls', hi: '' },
    care: JEWELLERY_CARE,
    dimensions: [
      { key: 'dropLength', value: '5.5 cm (2.2 in)' },
      { key: 'weight', value: '14 g per pair' },
    ],
    price: 7200,
    art: { kind: 'jhumka', color: '#bfc3c7', accent: '#9b2c2c' },
    stock: 0,
    reviews: [
      ['Lakshmi P.', 'Chennai, IN', 5, '2026-03-11', 'Heirloom feel', 'Wore them to my sister’s wedding and got so many compliments.'],
      ['Aisha N.', 'Toronto, CA', 4, '2026-02-26', 'Gorgeous detail', 'A little heavy for all-day wear but stunning.'],
    ],
    tags: ['earrings', 'jhumka', 'festive', 'silver'],
    createdAt: '2026-01-20',
    featuredRank: 16,
  },

  // ---------------- HOME DECOR ----------------
  {
    id: 'p-lamp',
    slug: 'rattan-table-lamp',
    categoryId: 'home-decor',
    name: { en: 'Rattan Table Lamp', hi: '' },
    shortDescription: { en: 'A hand-woven rattan lamp that casts a warm, patterned glow.', hi: '' },
    description: {
      en: 'Woven by hand over a steel frame, the open rattan shade throws soft patterns across the wall. Plug and cable specifications will depend on the destination country.',
      hi: '',
    },
    materials: { en: 'Natural rattan, powder-coated steel frame, fabric cable', hi: '' },
    care: {
      en: 'Dust with a soft brush. Use an LED bulb (not included). Electrical details shown here are illustrative only.',
      hi: '',
    },
    dimensions: [
      { key: 'height', value: '45 cm (17.7 in)' },
      { key: 'diameter', value: 'Shade 34 cm (13.4 in)' },
    ],
    price: 12000,
    art: { kind: 'lamp', color: '#c49a63' },
    stock: 5,
    reviews: [
      ['Marcus L.', 'Portland, US', 5, '2026-09-01', 'Gorgeous light', 'The shadows it casts are beautiful in the evenings.'],
      ['Divya K.', 'Goa, IN', 5, '2026-07-23', 'Better than the photos', 'Very well made and sturdy.'],
      ['Sophie A.', 'Bristol, UK', 4, '2026-05-15', 'Lovely lamp', 'Needed a plug adapter, so check the specs for your country.'],
    ],
    tags: ['lamp', 'lighting', 'rattan', 'home'],
    isFeatured: true,
    isBestseller: true,
    createdAt: '2026-02-01',
    featuredRank: 8,
  },
  {
    id: 'p-candle',
    slug: 'soy-candle-ceramic-holder',
    categoryId: 'home-decor',
    name: { en: 'Soy Candle in Ceramic Holder', hi: '' },
    shortDescription: { en: 'Hand-poured soy wax in a reusable stoneware cup.', hi: '' },
    description: {
      en: 'Hand-poured in small batches with a cotton wick and essential-oil blends. When the candle is finished, the stoneware cup becomes a planter or pen pot.',
      hi: '',
    },
    materials: { en: 'Soy wax, cotton wick, essential oils, stoneware holder', hi: '' },
    care: {
      en: 'Trim the wick to 5 mm before each burn. Never leave a burning candle unattended. Approx. 40 hours burn time.',
      hi: '',
    },
    dimensions: [
      { key: 'height', value: '9 cm (3.5 in)' },
      { key: 'diameter', value: '8 cm (3.1 in)' },
      { key: 'weight', value: 'Wax 200 g' },
    ],
    price: 3000,
    art: { kind: 'candle', color: '#e7dccb', accent: '#8a5a3c' },
    options: [
      {
        id: 'scent',
        name: { en: 'Scent', hi: '' },
        type: 'swatch',
        values: [v('sandalwood', 'Sandalwood', '', '#e7dccb'), v('jasmine', 'Jasmine', '', '#efe7e4'), v('vetiver', 'Vetiver', '', '#c9cfc0')],
      },
    ],
    artFor: (c) =>
      ({
        sandalwood: { color: '#e7dccb', accent: '#8a5a3c' },
        jasmine: { color: '#efe7e4', accent: '#c27c8e' },
        vetiver: { color: '#c9cfc0', accent: '#5c6b4a' },
      })[c.scent] ?? {},
    stock: (c) => ({ sandalwood: 25, jasmine: 18, vetiver: 10 })[c.scent] ?? 0,
    reviews: [
      ['Rhea J.', 'Mumbai, IN', 5, '2026-10-14', 'Smells divine', 'Vetiver is earthy and fresh, perfect for monsoon evenings.'],
      ['Liam O.', 'Cork, IE', 4, '2026-10-02', 'Lovely holder', 'Scent is subtle; great if you prefer gentle fragrance.'],
    ],
    tags: ['candle', 'soy', 'gift', 'fragrance'],
    isFeatured: true,
    isNew: true,
    createdAt: '2026-09-30',
    featuredRank: 6.5,
  },
  {
    id: 'p-cushion',
    slug: 'block-print-cushion-cover',
    categoryId: 'home-decor',
    name: { en: 'Block-print Cushion Cover', hi: '' },
    shortDescription: { en: 'Hand block-printed cotton with a concealed zip.', hi: '' },
    description: {
      en: 'Printed by hand in Rajasthan using carved wooden blocks and natural pigments, finished with cotton tassels and a hidden zip. Insert not included.',
      hi: '',
    },
    materials: { en: '100% cotton, natural pigments', hi: '' },
    care: { en: 'Machine wash cold on a gentle cycle. Do not tumble dry.', hi: '' },
    dimensions: [
      { key: 'width', value: '45 cm (17.7 in)' },
      { key: 'height', value: '45 cm (17.7 in)' },
    ],
    price: 4000,
    art: { kind: 'cushion', color: '#efe6d6', accent: '#34497a' },
    options: [opt.color([v('indigo', 'Indigo', '', '#34497a'), v('rust', 'Rust', '', '#b4532a'), v('sage', 'Sage', '', '#6f7d5c')])],
    artFor: (c) =>
      ({
        indigo: { color: '#efe6d6', accent: '#34497a' },
        rust: { color: '#f2e8da', accent: '#b4532a' },
        sage: { color: '#e9ebe0', accent: '#6f7d5c' },
      })[c.color] ?? {},
    stock: (c) => ({ indigo: 12, rust: 0, sage: 8 })[c.color] ?? 0,
    reviews: [
      ['Neha A.', 'Lucknow, IN', 5, '2026-08-08', 'Beautiful print', 'The indigo is deep and the print is crisp.'],
      ['Ella R.', 'Edinburgh, UK', 5, '2026-07-04', 'Instant refresh', 'Changed the whole feel of my sofa.'],
      ['Mateo F.', 'Barcelona, ES', 4, '2026-05-21', 'Good quality', 'Washed well, slight colour fade on first wash as described.'],
    ],
    tags: ['cushion', 'block print', 'textile', 'home'],
    isBestseller: true,
    createdAt: '2026-03-18',
    featuredRank: 9.5,
  },
  {
    id: 'p-macrame',
    slug: 'macrame-wall-hanging',
    categoryId: 'home-decor',
    name: { en: 'Macramé Wall Hanging', hi: '' },
    shortDescription: { en: 'Knotted cotton cord on a reclaimed wood dowel.', hi: '' },
    description: {
      en: 'A diamond pattern of square knots with a brushed-out fringe, hung from a dowel of reclaimed wood. Adds texture and softness to a bare wall.',
      hi: '',
    },
    materials: { en: 'Recycled cotton cord, reclaimed wood', hi: '' },
    care: { en: 'Shake gently to remove dust. Comb the fringe with fingers if needed.', hi: '' },
    dimensions: [
      { key: 'width', value: 'Small 40 cm / Large 60 cm' },
      { key: 'length', value: 'Small 65 cm / Large 95 cm' },
    ],
    price: 5800,
    art: { kind: 'macrame', color: '#d8c3a0' },
    options: [opt.size([v('s', 'Small', ''), v('l', 'Large', '')])],
    priceFor: (c) => ({ price: c.size === 'l' ? 9200 : 5800 }),
    stock: (c) => (c.size === 's' ? 6 : 3),
    reviews: [['Ivy C.', 'Singapore, SG', 5, '2026-06-30', 'So soft', 'Large size makes a real statement above the bed.']],
    tags: ['macrame', 'wall art', 'textile'],
    createdAt: '2026-04-25',
    featuredRank: 17,
  },
  {
    id: 'p-planter',
    slug: 'terracotta-planter',
    categoryId: 'home-decor',
    name: { en: 'Terracotta Planter', hi: '' },
    shortDescription: { en: 'An unglazed terracotta pot with a drainage hole.', hi: '' },
    description: {
      en: 'Thrown from local red clay and left unglazed so roots can breathe. Includes a drainage hole and a matching saucer. Plant not included.',
      hi: '',
    },
    materials: { en: 'Unglazed terracotta', hi: '' },
    care: { en: 'Suitable indoors and outdoors. Bring inside during frost.', hi: '' },
    dimensions: [
      { key: 'diameter', value: 'Small 14 cm / Large 22 cm' },
      { key: 'height', value: 'Small 12 cm / Large 19 cm' },
    ],
    price: 2600,
    art: { kind: 'planter', color: '#c46a43' },
    options: [opt.size([v('s', 'Small', ''), v('l', 'Large', '')])],
    priceFor: (c) => ({ price: c.size === 'l' ? 3800 : 2600 }),
    stock: (c) => (c.size === 's' ? 16 : 10),
    reviews: [],
    tags: ['planter', 'terracotta', 'garden', 'plants'],
    isNew: true,
    createdAt: '2026-10-18',
    featuredRank: 18,
  },
];
