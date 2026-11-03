/**
 * Import DIGNITYARTEDGE products from Excel — batch version (fast).
 * Run: npx tsx scripts/import-dignity-products.ts
 * INR → USD: 1 USD = 84 INR
 */
import { createRequire } from 'node:module';
import { prisma } from '../src/db.js';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const XLSX = require('xlsx');

const INR_TO_USD = 84;
const toCents = (inr: number) => Math.round((inr / INR_TO_USD) * 100);
const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
let _seq = 0;
const uid = () => `${Date.now().toString(36)}${(++_seq).toString(36).padStart(4, '0')}`;

interface Row { product_name: string; category: string; description: string; mrp_inr: number; sale_inr: number; stock: number; size_label: string; size_price_inr: number; }

async function run() {
  const wb = XLSX.readFile('C:\\Users\\mannu\\Downloads\\DIGNITYARTEDGE_products_formatted.xlsx');
  const rows: Row[] = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
  console.log(`Loaded ${rows.length} rows`);

  // Group by product
  const productMap = new Map<string, Row[]>();
  for (const r of rows) {
    const k = r.product_name?.toString().trim();
    if (!k) continue;
    if (!productMap.has(k)) productMap.set(k, []);
    productMap.get(k)!.push(r);
  }
  console.log(`Unique products: ${productMap.size}`);

  // Categories
  const catNames = [...new Set(rows.map((r) => r.category?.toString().trim()).filter(Boolean))];
  const catIdMap = new Map<string, string>();
  for (let i = 0; i < catNames.length; i++) {
    const name = catNames[i];
    const cat = await prisma.category.upsert({
      where: { slug: slugify(name) },
      create: { id: uid(), slug: slugify(name), nameEn: name, nameHi: '', descriptionEn: '', descriptionHi: '', displayOrder: i, isActive: true },
      update: {},
    });
    catIdMap.set(name, cat.id);
  }
  console.log(`${catNames.length} categories ready.`);

  // Build all data in memory first
  const allProducts: Parameters<typeof prisma.product.createMany>[0]['data'] = [];
  const allOptions: Parameters<typeof prisma.productOption.createMany>[0]['data'] = [];
  const allValues: Parameters<typeof prisma.productOptionValue.createMany>[0]['data'] = [];
  const allVariants: Parameters<typeof prisma.productVariant.createMany>[0]['data'] = [];

  // Track used slugs
  const usedSlugs = new Set<string>();

  for (const [productName, variants] of productMap) {
    const catId = catIdMap.get(variants[0].category?.toString().trim());
    if (!catId) continue;

    const baseSlug = slugify(productName);
    let slug = baseSlug;
    let attempt = 0;
    while (usedSlugs.has(slug)) { attempt++; slug = `${baseSlug}-${attempt}`; }
    usedSlugs.add(slug);

    const mrpCents = toCents(Number(variants[0].mrp_inr) || 0);
    const saleCents = toCents(Number(variants[0].sale_inr) || 0);
    const hasSale = saleCents > 0 && saleCents < mrpCents;
    const desc = variants[0].description?.toString().trim() ?? '';
    const productId = uid();
    const optionId = uid();

    allProducts.push({
      id: productId, slug, status: 'active',
      nameEn: productName, nameHi: '', nameSearch: productName.toLowerCase(),
      shortDescriptionEn: desc.slice(0, 300), shortDescriptionHi: '',
      descriptionEn: desc, descriptionHi: '',
      categoryId: catId, tags: '[]', searchText: productName.toLowerCase(),
      basePrice: mrpCents, baseSalePrice: hasSale ? saleCents : null,
      materialsEn: '', materialsHi: '', careEn: '', careHi: '',
      isFeatured: false, isBestseller: false, isNew: true,
      displayOrder: allProducts.length,
      seoTitleEn: '', seoTitleHi: '', seoDescriptionEn: '', seoDescriptionHi: '',
    });

    allOptions.push({ id: optionId, productId, nameEn: 'Size', nameHi: '', type: 'button', position: 0 });

    for (let vi = 0; vi < variants.length; vi++) {
      const v = variants[vi];
      const rawLabel = v.size_label?.toString().trim() ?? `Size ${vi + 1}`;
      const cleanLabel = rawLabel.replace(/\s*\(.*\)/, '').trim() || rawLabel;
      const valueId = uid();

      allValues.push({ id: valueId, optionId, labelEn: cleanLabel.slice(0, 191), labelHi: '', position: vi });

      allVariants.push({
        id: uid(),
        productId,
        sku: `DAE${(allVariants.length + 1).toString().padStart(5, '0')}`,
        options: JSON.stringify({ [optionId]: valueId }),
        price: toCents(Number(v.size_price_inr) || Number(v.sale_inr) || mrpCents),
        salePrice: null,
        stock: Math.round(Number(v.stock) || 0),
        imageIds: '[]',
        position: vi,
      });
    }
  }

  console.log(`Inserting ${allProducts.length} products, ${allOptions.length} options, ${allValues.length} values, ${allVariants.length} variants...`);

  await prisma.product.createMany({ data: allProducts });
  console.log('  products done');
  await prisma.productOption.createMany({ data: allOptions });
  console.log('  options done');
  await prisma.productOptionValue.createMany({ data: allValues });
  console.log('  option values done');

  // variants in chunks (3321 rows may hit param limit)
  const CHUNK = 500;
  for (let i = 0; i < allVariants.length; i += CHUNK) {
    await prisma.productVariant.createMany({ data: allVariants.slice(i, i + CHUNK) });
    process.stdout.write(`  variants ${Math.min(i + CHUNK, allVariants.length)}/${allVariants.length}\r`);
  }

  console.log(`\nDone. ${allProducts.length} products imported.`);
  await prisma.$disconnect();
}

run().catch((e) => { console.error(e.message ?? e); process.exit(1); });
