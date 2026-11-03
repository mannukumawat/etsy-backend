import type { ArtKind, ArtSpec, CompositeItem } from './art.js';
import type { ProductSource, SourceOption } from './catalogSource.js';

// Extended sample catalogue: 15 more categories with 12 products each (180), generated
// deterministically so re-running the seed produces exactly the same ids, names and prices.
// Every product uses one of the art generator's drawable kinds, so each gets real images.

type Theme = 'warm' | 'soft' | 'sage' | 'linen' | 'stone' | 'blush';

interface CategoryDef {
  id: string;
  name: string;
  description: string;
  theme: Theme;
  /** noun → which drawing to use for it */
  nouns: Array<[string, ArtKind]>;
  palette: Array<[string, string]>;
  accent?: string;
  pattern?: 'jute' | 'print';
  price: [number, number];
  materials: string;
  care: string;
  dims: Array<{ key: string; value: string }>;
  tags: string[];
  blurb: string;
}

const EARTH: Array<[string, string]> = [
  ['Sand', '#e6d3b8'], ['Sage', '#a9b49a'], ['Terracotta', '#c46a43'], ['Ivory', '#efe6d6'], ['Charcoal', '#4a4542'],
  ['Indigo', '#3b4f7a'], ['Blush', '#e3b9a8'], ['Ochre', '#c9963b'], ['Olive', '#7d8255'], ['Rust', '#a4532f'], ['Slate', '#6f7b85'], ['Moss', '#5f7350'],
];
const METALS: Array<[string, string]> = [['Gold', '#c9a24a'], ['Silver', '#b9bcc0'], ['Rose gold', '#d4a18c'], ['Brass', '#b38b4d'], ['Copper', '#b8734a']];
const FABRIC: Array<[string, string]> = [['Natural', '#e8dcc8'], ['Indigo', '#3b4f7a'], ['Madder red', '#a8473b'], ['Mustard', '#d2a03c'], ['Forest', '#4d6650'], ['Clay', '#b9805e'], ['Charcoal', '#4a4542']];

const CERAMIC_CARE = 'Dishwasher and microwave safe. Avoid sudden temperature changes. Small variations in glaze are part of each handmade piece.';
const TEXTILE_CARE = 'Hand wash cold or gentle machine wash inside out. Dry flat in the shade. Natural dyes may soften slightly over time.';
const JEWELLERY_CARE = 'Store in the pouch provided. Remove before swimming or bathing. Polish gently with a soft dry cloth.';
const BAG_CARE = 'Spot clean with a damp cloth. Stuff with paper to keep its shape when not in use. Keep away from prolonged direct sunlight.';

const CATEGORIES: CategoryDef[] = [
  { id: 'mugs-cups', name: 'Mugs & Cups', description: 'Wheel-thrown mugs, cups and tumblers for your daily brew.', theme: 'warm', nouns: [['Mug', 'mug'], ['Coffee Cup', 'mug'], ['Tea Tumbler', 'mug'], ['Latte Mug', 'mug'], ['Chai Cup', 'mug']], palette: EARTH, price: [1800, 3600], materials: 'Stoneware clay, lead-free food-safe glaze', care: CERAMIC_CARE, dims: [{ key: 'height', value: '9.5 cm (3.7 in)' }, { key: 'capacity', value: '300 ml (10 oz)' }], tags: ['mug', 'coffee', 'tea', 'stoneware'], blurb: 'thrown on the wheel and glazed by hand, with a comfortable handle and a satisfying weight' },
  { id: 'kitchen-dining', name: 'Kitchen & Dining', description: 'Plates, bowls and teapots made to be used and loved every day.', theme: 'linen', nouns: [['Dinner Plate Set', 'plates'], ['Serving Bowl', 'bowl'], ['Pasta Bowl', 'bowl'], ['Side Plates', 'plates'], ['Teapot', 'teapot'], ['Salad Bowl', 'bowl']], palette: EARTH, price: [2600, 9800], materials: 'Stoneware clay, food-safe glaze', care: CERAMIC_CARE, dims: [{ key: 'diameter', value: '26 cm (10.2 in)' }], tags: ['tableware', 'kitchen', 'dining', 'ceramic'], blurb: 'made for everyday meals and long weekend lunches alike' },
  { id: 'vases', name: 'Vases', description: 'Bud vases and statement vessels for fresh and dried flowers.', theme: 'soft', nouns: [['Bud Vase', 'vase'], ['Bottle Vase', 'vase'], ['Flower Vase', 'vase'], ['Bud Vase Trio', 'vase'], ['Amphora Vase', 'vase']], palette: EARTH, accent: '#2f4a7a', price: [2400, 7800], materials: 'Stoneware, hand-painted underglaze', care: 'Watertight. Hand wash only. Change water often for fresh flowers.', dims: [{ key: 'height', value: '18 cm (7 in)' }], tags: ['vase', 'flowers', 'decor'], blurb: 'shaped on the wheel and painted with simple, hand-drawn marks' },
  { id: 'lighting', name: 'Lighting', description: 'Woven and ceramic lamps that cast a soft, warm glow.', theme: 'warm', nouns: [['Table Lamp', 'lamp'], ['Bedside Lamp', 'lamp'], ['Rattan Lamp', 'lamp'], ['Reading Lamp', 'lamp'], ['Desk Lamp', 'lamp']], palette: [['Natural', '#c9a36b'], ['Honey', '#d2a14f'], ['Walnut', '#8a5a3b'], ['Ivory', '#efe6d6'], ['Charcoal', '#4a4542']], price: [5800, 16800], materials: 'Rattan or ceramic base, linen shade, E27 fitting', care: 'Dust gently with a dry brush. Use bulbs up to 40 W (LED recommended).', dims: [{ key: 'height', value: '42 cm (16.5 in)' }], tags: ['lamp', 'lighting', 'home'], blurb: 'giving a soft, diffused light that makes any corner feel cosy' },
  { id: 'candles', name: 'Candles & Fragrance', description: 'Hand-poured soy candles in reusable ceramic holders.', theme: 'blush', nouns: [['Soy Candle', 'candle'], ['Scented Candle', 'candle'], ['Travel Candle', 'candle'], ['Pillar Candle', 'candle'], ['Candle Gift Set', 'candle']], palette: [['Ivory', '#efe6d6'], ['Sand', '#e6d3b8'], ['Blush', '#e3b9a8'], ['Sage', '#a9b49a'], ['Charcoal', '#4a4542']], price: [1600, 4800], materials: 'Soy wax, cotton wick, essential-oil fragrance, ceramic holder', care: 'Trim the wick to 5 mm before each burn. Never leave a burning candle unattended.', dims: [{ key: 'height', value: '9 cm (3.5 in)' }], tags: ['candle', 'fragrance', 'gift'], blurb: 'hand-poured in small batches with a clean, slow burn' },
  { id: 'cushions', name: 'Cushions & Throws', description: 'Block-printed and woven cushion covers in natural cotton and linen.', theme: 'linen', nouns: [['Cushion Cover', 'cushion'], ['Lumbar Cushion', 'cushion'], ['Floor Cushion', 'cushion'], ['Linen Cushion', 'cushion'], ['Printed Cushion', 'cushion']], palette: FABRIC, accent: '#2f4a7a', pattern: 'print', price: [1800, 5200], materials: '100% cotton or linen, hand block-printed, zip closure', care: TEXTILE_CARE, dims: [{ key: 'width', value: '45 × 45 cm (18 × 18 in)' }], tags: ['cushion', 'textile', 'block print'], blurb: 'printed by hand with carved wooden blocks, so every repeat is slightly different' },
  { id: 'wall-decor', name: 'Wall Decor', description: 'Macramé hangings and woven pieces to soften a bare wall.', theme: 'soft', nouns: [['Macramé Wall Hanging', 'macrame'], ['Woven Wall Hanging', 'macrame'], ['Plant Hanger', 'macrame'], ['Fringe Wall Art', 'macrame'], ['Mini Wall Hanging', 'macrame']], palette: [['Natural', '#e8dcc8'], ['Oat', '#d9cbb0'], ['Rust', '#a4532f'], ['Sage', '#a9b49a'], ['Charcoal', '#4a4542']], price: [2200, 8800], materials: 'Recycled cotton cord, driftwood or bamboo rod', care: 'Shake out dust gently. Spot clean only.', dims: [{ key: 'length', value: '60 cm (24 in)' }], tags: ['wall art', 'macrame', 'boho'], blurb: 'knotted by hand from soft recycled cotton cord' },
  { id: 'planters', name: 'Planters & Garden', description: 'Terracotta and glazed planters for indoor greenery.', theme: 'sage', nouns: [['Terracotta Planter', 'planter'], ['Glazed Planter', 'planter'], ['Herb Pot', 'planter'], ['Hanging Planter', 'planter'], ['Succulent Pot', 'planter']], palette: [['Terracotta', '#c46a43'], ['Sand', '#e6d3b8'], ['Sage', '#a9b49a'], ['Charcoal', '#4a4542'], ['Ivory', '#efe6d6']], price: [1400, 5600], materials: 'Terracotta or stoneware, drainage hole with saucer', care: 'Suitable for indoor use. Empty the saucer after watering.', dims: [{ key: 'diameter', value: '15 cm (6 in)' }], tags: ['planter', 'plants', 'garden'], blurb: 'with a drainage hole and matching saucer so your plants stay happy' },
  { id: 'totes', name: 'Totes & Shoppers', description: 'Canvas totes and woven market baskets for everyday carrying.', theme: 'warm', nouns: [['Canvas Tote', 'tote'], ['Market Basket', 'basketBag'], ['Shopper Bag', 'tote'], ['Beach Basket', 'basketBag'], ['Book Bag', 'tote']], palette: FABRIC, accent: '#8a5530', price: [1800, 6800], materials: 'Heavy cotton canvas or palm-leaf weave, leather handles', care: BAG_CARE, dims: [{ key: 'width', value: '38 cm (15 in)' }], tags: ['tote', 'bag', 'everyday'], blurb: 'roomy enough for groceries, a laptop or a day at the beach' },
  { id: 'clutches', name: 'Clutches & Pouches', description: 'Jute clutches and block-printed pouches for evenings out.', theme: 'blush', nouns: [['Evening Clutch', 'clutch'], ['Zip Pouch', 'clutch'], ['Jute Clutch', 'clutch'], ['Wristlet', 'clutch'], ['Envelope Clutch', 'clutch']], palette: FABRIC, accent: '#2f4a7a', pattern: 'jute', price: [1400, 4800], materials: 'Jute or cotton, cotton lining, metal clasp', care: BAG_CARE, dims: [{ key: 'width', value: '26 cm (10 in)' }], tags: ['clutch', 'pouch', 'evening'], blurb: 'hand-finished with a cotton lining and a secure clasp' },
  { id: 'crossbody-bags', name: 'Crossbody Bags', description: 'Leather crossbody and shoulder bags that go everywhere with you.', theme: 'stone', nouns: [['Crossbody Bag', 'crossbody'], ['Saddle Bag', 'crossbody'], ['Phone Bag', 'crossbody'], ['Shoulder Bag', 'crossbody'], ['Camera Bag', 'crossbody']], palette: [['Tan', '#a86b3c'], ['Chestnut', '#7a4a2e'], ['Black', '#2f2b28'], ['Olive', '#7d8255'], ['Burgundy', '#6e2f2f']], price: [4800, 14800], materials: 'Vegetable-tanned leather, cotton lining, brass hardware', care: 'Condition the leather twice a year. Keep dry; wipe spills straight away.', dims: [{ key: 'width', value: '24 cm (9.5 in)' }], tags: ['leather', 'crossbody', 'bag'], blurb: 'cut and stitched from vegetable-tanned leather that ages beautifully' },
  { id: 'necklaces', name: 'Necklaces', description: 'Delicate pendants and chains, cut and polished by hand.', theme: 'soft', nouns: [['Leaf Pendant', 'necklace'], ['Pendant Necklace', 'necklace'], ['Charm Necklace', 'necklace'], ['Layering Chain', 'necklace'], ['Coin Necklace', 'necklace']], palette: METALS, price: [2200, 8800], materials: 'Recycled brass or sterling silver, adjustable chain', care: JEWELLERY_CARE, dims: [{ key: 'chain', value: '45 cm (18 in) with 5 cm extender' }], tags: ['necklace', 'jewellery', 'pendant'], blurb: 'cut, filed and polished by hand from recycled metal' },
  { id: 'earrings', name: 'Earrings', description: 'Hammered hoops and filigree jhumkas for every day and occasions.', theme: 'blush', nouns: [['Hoop Earrings', 'hoops'], ['Jhumka Earrings', 'jhumka'], ['Huggie Hoops', 'hoops'], ['Drop Earrings', 'jhumka'], ['Statement Hoops', 'hoops']], palette: METALS, price: [1800, 7800], materials: 'Recycled brass or sterling silver, hypoallergenic hooks', care: JEWELLERY_CARE, dims: [{ key: 'dropLength', value: '3.5 cm (1.4 in)' }], tags: ['earrings', 'jewellery', 'hoops'], blurb: 'lightweight enough to wear all day' },
  { id: 'rings', name: 'Rings', description: 'Stacking rings and gemstone bands made to order in your size.', theme: 'linen', nouns: [['Stacking Ring', 'ring'], ['Gemstone Ring', 'ring'], ['Signet Ring', 'ring'], ['Band Ring', 'ring'], ['Moonstone Ring', 'ring']], palette: METALS, accent: '#cfe0ea', price: [1800, 9800], materials: 'Sterling silver or recycled gold-fill, natural gemstone', care: JEWELLERY_CARE, dims: [{ key: 'width', value: '1.5 mm band' }], tags: ['ring', 'jewellery', 'stacking'], blurb: 'shaped and set by hand, perfect on its own or stacked' },
  { id: 'bracelets', name: 'Bracelets', description: 'Beaded, cuff and chain bracelets in natural stones and metals.', theme: 'sage', nouns: [['Beaded Bracelet', 'bracelet'], ['Gemstone Bracelet', 'bracelet'], ['Cuff Bracelet', 'bracelet'], ['Charm Bracelet', 'bracelet'], ['Friendship Bracelet', 'bracelet']], palette: [['Rose quartz', '#e3b9a8'], ['Amazonite', '#9cc5b8'], ['Onyx', '#2f2b28'], ['Tiger eye', '#b58340'], ['Lapis', '#3b4f7a'], ['Moonstone', '#e6e3dc']], price: [1600, 6800], materials: 'Natural stone beads, stretch cord or recycled metal', care: JEWELLERY_CARE, dims: [{ key: 'length', value: '16–18 cm (6.3–7 in)' }], tags: ['bracelet', 'jewellery', 'gemstone'], blurb: 'strung by hand from natural stones, each with its own markings' },
];

const ADJECTIVES = ['Speckled', 'Hand-thrown', 'Rustic', 'Coastal', 'Heirloom', 'Studio', 'Classic', 'Everyday', 'Artisan', 'Minimal', 'Botanical', 'Vintage-style', 'Hammered', 'Woven', 'Organic', 'Folk'];

function rng(seed: string) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 3432918353), (h = (h << 13) | (h >>> 19));
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const PER_CATEGORY = 12;

export const EXTRA_CATEGORY_SOURCES = CATEGORIES.map((c) => {
  const [p0, p1, p2] = [c.palette[0], c.palette[2 % c.palette.length], c.palette[4 % c.palette.length]];
  const kinds = [...new Set(c.nouns.map((n) => n[1]))];
  const spec = (k: ArtKind, color: string): ArtSpec => ({ kind: k, color, ...(c.accent ? { accent: c.accent } : {}), ...(c.pattern ? { pattern: c.pattern } : {}) });
  const banner: CompositeItem[] = [
    { spec: spec(kinds[0], p0[1]), x: 1000, baseY: 368, scale: 0.75 },
    { spec: spec(kinds[1 % kinds.length], p1[1]), x: 1240, baseY: 370, scale: 0.7 },
    { spec: spec(kinds[2 % kinds.length], p2[1]), x: 1460, baseY: 372, scale: 0.62 },
  ];
  return { id: c.id, name: { en: c.name, hi: '' }, description: { en: c.description, hi: '' }, image: { ...spec(kinds[0], p0[1]), seed: 'cat' }, banner, theme: c.theme };
});

export const EXTRA_PRODUCT_SOURCES: ProductSource[] = CATEGORIES.flatMap((c) => {
  const r = rng(`extra|${c.id}`);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const used = new Set<string>();
  const out: ProductSource[] = [];
  for (let i = 0; i < PER_CATEGORY; i++) {
    let adj = '';
    let noun: [string, ArtKind] = c.nouns[0];
    for (let tries = 0; tries < 50; tries++) {
      adj = pick(ADJECTIVES);
      noun = c.nouns[i % c.nouns.length];
      if (!used.has(`${adj} ${noun[0]}`)) break;
    }
    const name = `${adj} ${noun[0]}`;
    used.add(name);
    const [colorName, colorHex] = c.palette[(i * 3 + Math.floor(r() * 3)) % c.palette.length];

    const step = 100;
    const price = Math.round((c.price[0] + r() * (c.price[1] - c.price[0])) / step) * step;
    const onSale = r() < 0.22;
    const salePrice = onSale ? Math.round((price * (0.7 + r() * 0.15)) / step) * step : undefined;

    const withColours = r() < 0.4;
    const colourValues = withColours ? [0, 1, 2].map((k) => c.palette[(i + k * 2) % c.palette.length]) : [];
    const options: SourceOption[] = withColours
      ? [{ id: 'color', name: { en: 'Colour', hi: '' }, type: 'swatch', values: colourValues.map(([n, hex]) => ({ id: slugify(n), label: { en: n, hi: '' }, swatch: hex })) }]
      : [];
    const colourHexById = Object.fromEntries(colourValues.map(([n, hex]) => [slugify(n), hex]));
    const stockRoll = r();
    const baseStock = stockRoll < 0.08 ? 0 : stockRoll < 0.2 ? 1 + Math.floor(r() * 4) : 6 + Math.floor(r() * 30);

    const isNew = r() < 0.2;
    const month = isNew ? 9 + Math.floor(r() * 2) : 3 + Math.floor(r() * 6);
    const day = 1 + Math.floor(r() * 27);

    const art: ArtSpec = { kind: noun[1], color: withColours ? colourValues[0][1] : colorHex, ...(c.accent ? { accent: c.accent } : {}), ...(c.pattern ? { pattern: c.pattern } : {}) };
    const material = c.materials.split(',')[0].toLowerCase();

    out.push({
      id: `p-${c.id}-${String(i + 1).padStart(2, '0')}`,
      slug: slugify(`${name}-${c.id}-${i + 1}`),
      categoryId: c.id,
      name: { en: name, hi: '' },
      shortDescription: { en: `${withColours ? 'Available in several colours' : `In ${colorName.toLowerCase()}`} — ${c.blurb}.`, hi: '' },
      description: {
        en: `Our ${name.toLowerCase()} is made in small batches in our studio, ${c.blurb}. Crafted from ${material}, it brings a quietly handmade touch to your everyday. Because every piece is made by hand, expect small variations that make yours one of a kind.`,
        hi: '',
      },
      materials: { en: c.materials, hi: '' },
      care: { en: c.care, hi: '' },
      dimensions: c.dims,
      price,
      ...(salePrice !== undefined ? { salePrice } : {}),
      art,
      ...(withColours ? { artFor: (combo: Record<string, string>) => ({ color: colourHexById[combo.color] }) } : {}),
      ...(withColours ? { options } : {}),
      stock: withColours ? (combo: Record<string, string>) => Math.max(0, baseStock - colourValues.findIndex(([n]) => slugify(n) === combo.color) * 3) : baseStock,
      reviews: [],
      tags: [...c.tags, adj.toLowerCase(), colorName.toLowerCase()],
      isFeatured: r() < 0.1,
      isBestseller: r() < 0.12,
      isNew,
      createdAt: `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      featuredRank: 100 + out.length,
    });
  }
  return out;
});
