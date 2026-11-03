/**
 * Idempotent DIGNITYARTEDGE catalog import.
 * Run: npx tsx scripts/import-catalog.ts
 * Force rebuild: IMPORT_FORCE=1 npx tsx scripts/import-catalog.ts
 *
 * Stable seed key = product slug. Re-running skips already-present products.
 * IMPORT_FORCE=1 rebuilds options and variants but preserves product id and images.
 */
import 'dotenv/config';
import { createRequire } from 'node:module';
import { PrismaClient } from '@prisma/client';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');

const p = new PrismaClient();
const FORCE = process.env.IMPORT_FORCE === '1';
const XLSX_PATH = 'C:\\Users\\mannu\\Downloads\\DIGNITYARTEDGE_products_formatted.xlsx';

const INR_TO_USD = 84;
const toCents = (inr: number) => Math.round((inr / INR_TO_USD) * 100);

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

let _seq = 0;
const uid = () => `${Date.now().toString(36)}${(++_seq).toString(36).padStart(4, '0')}`;

// Category slug corrections (Excel category names → DB slugs after fix-categories.ts)
const CAT_SLUG_MAP: Record<string, string> = {
  'Kilim Rug': 'kilim-rugs',
  'Wool & Jute Runner': 'wool-jute-runners',
  'Kilim Bench': 'kilim-benches',
  'Cotton Yoga Mat': 'cotton-yoga-mats',
  'Throw & Blanket': 'throws',
  'Jute Rug': 'jute-rugs',
  'Cushion Cover': 'cushion-covers',
  'Scalloped Jute Rug': 'scalloped-jute-rugs',
  'Round Jute Rug': 'round-jute-rugs',
};

interface Row {
  product_name: string;
  category: string;
  description: string;
  mrp_inr: number;
  sale_inr: number;
  stock: number;
  size_label: string;
  size_price_inr: number;
}

async function importProduct(
  productName: string,
  catId: string,
  catSlug: string,
  variants: Row[],
  displayOrder: number,
): Promise<'created' | 'updated' | 'skipped' | 'error'> {
  const slug = slugify(productName);

  const existing = await p.product.findUnique({ where: { slug } });
  if (existing && !FORCE) return 'skipped';

  const baseRow = variants[0];
  const mrpCents = toCents(Number(baseRow.mrp_inr) || 0);
  const saleCents = toCents(Number(baseRow.sale_inr) || 0);
  const hasSale = saleCents > 0 && saleCents < mrpCents;
  const desc = baseRow.description?.toString().trim() ?? '';

  const productData = {
    slug,
    status: 'active' as const,
    nameEn: productName,
    nameHi: '',
    nameSearch: productName.toLowerCase(),
    shortDescriptionEn: desc.slice(0, 300),
    shortDescriptionHi: '',
    descriptionEn: desc,
    descriptionHi: '',
    categoryId: catId,
    tags: '[]',
    searchText: `${productName.toLowerCase()} ${catSlug.replace(/-/g, ' ')}`,
    basePrice: mrpCents,
    baseSalePrice: hasSale ? saleCents : null,
    materialsEn: '',
    materialsHi: '',
    careEn: '',
    careHi: '',
    isFeatured: false,
    isBestseller: false,
    isNew: true,
    displayOrder,
    seoTitleEn: productName.slice(0, 191),
    seoTitleHi: '',
    seoDescriptionEn: desc.slice(0, 160),
    seoDescriptionHi: '',
  };

  let productId: string;
  let action: 'created' | 'updated';

  if (existing) {
    await p.product.update({ where: { id: existing.id }, data: productData });
    await p.productVariant.deleteMany({ where: { productId: existing.id } });
    await p.productOption.deleteMany({ where: { productId: existing.id } });
    productId = existing.id;
    action = 'updated';
  } else {
    productId = uid();
    await p.product.create({ data: { id: productId, ...productData } });
    action = 'created';
  }

  // Create size option
  const optionId = uid();
  await p.productOption.create({ data: { id: optionId, productId, nameEn: 'Size', nameHi: '', type: 'button', position: 0 } });

  // Create option values and variants
  const usedLabels = new Set<string>();
  let vi = 0;
  for (const v of variants) {
    const rawLabel = v.size_label?.toString().trim() ?? `Size ${vi + 1}`;
    const cleanLabel = rawLabel.replace(/\s*\(.*\)/, '').trim() || rawLabel;
    if (usedLabels.has(cleanLabel)) continue;
    usedLabels.add(cleanLabel);

    const valueId = uid();
    await p.productOptionValue.create({ data: { id: valueId, optionId, labelEn: cleanLabel.slice(0, 191), labelHi: '', position: vi } });

    const varPrice = toCents(Number(v.size_price_inr) || Number(v.sale_inr) || mrpCents);
    await p.productVariant.create({
      data: {
        id: uid(),
        productId,
        sku: `DAE-${slug.slice(0, 18).toUpperCase()}-${vi + 1}`,
        options: JSON.stringify({ [optionId]: valueId }),
        price: varPrice,
        salePrice: null,
        stock: Math.round(Number(v.stock) || 0),
        imageIds: '[]',
        position: vi,
      },
    });
    vi++;
  }

  return action;
}

async function main() {
  const wb = XLSX.readFile(XLSX_PATH);
  const rows: Row[] = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
  console.log(`Loaded ${rows.length} rows from Excel`);

  // Group rows by product_name
  const productMap = new Map<string, { cat: string; rows: Row[] }>();
  for (const r of rows) {
    const name = r.product_name?.toString().trim();
    const cat = r.category?.toString().trim();
    if (!name || !cat) continue;
    if (!productMap.has(name)) productMap.set(name, { cat, rows: [] });
    productMap.get(name)!.rows.push(r);
  }
  console.log(`Unique products: ${productMap.size}`);

  // Load categories
  const cats = await p.category.findMany({ select: { id: true, slug: true } });
  const catBySlug = new Map(cats.map((c) => [c.slug, c.id]));

  let created = 0, updated = 0, skipped = 0, errors = 0;
  let order = 0;

  for (const [productName, { cat, rows: variantRows }] of productMap) {
    const catSlug = CAT_SLUG_MAP[cat] ?? slugify(cat);
    const catId = catBySlug.get(catSlug);
    if (!catId) {
      console.warn(`  WARN no category for: "${cat}" (slug: ${catSlug})`);
      errors++;
      continue;
    }

    const result = await importProduct(productName, catId, catSlug, variantRows, order++);
    if (result === 'created') { created++; process.stdout.write('+'); }
    else if (result === 'updated') { updated++; process.stdout.write('~'); }
    else if (result === 'skipped') { skipped++; process.stdout.write('.'); }
    else { errors++; process.stdout.write('!'); }
  }

  console.log(`\n\nCreated: ${created} | Updated: ${updated} | Skipped: ${skipped} | Errors: ${errors}`);

  // Final verification
  console.log('\nCatalog state:');
  const finalCats = await p.category.findMany({
    select: { slug: true, nameEn: true, _count: { select: { products: true } } },
    orderBy: { displayOrder: 'asc' },
  });
  for (const c of finalCats) console.log(`  ${c.slug} | ${c.nameEn} | ${c._count.products}`);
  console.log(`  Total: ${await p.product.count()} products`);

  await p.$disconnect();
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
