import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as crypto from 'crypto';

const prisma = new PrismaClient();

function makeId(): string {
  return crypto.randomBytes(12).toString('hex');
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
}

function parsePriceFromLabel(label: string): number | null {
  const m = label.match(/₹\s*([\d,]+)/);
  if (!m) return null;
  return parseInt(m[1].replace(/,/g, ''), 10) * 100;
}

async function main() {
  const raw = fs.readFileSync(
    'C:/Users/mannu/Downloads/DIGNITYARTEDGE_catalog/DIGNITYARTEDGE_products.json',
    'utf-8',
  );
  const data = JSON.parse(raw);
  const products: any[] = data.products;

  // --- 1. Upsert categories ---
  const seenCats = new Set<string>();
  const categoryNames: string[] = [];
  for (const p of products) {
    if (!seenCats.has(p.category)) { seenCats.add(p.category); categoryNames.push(p.category); }
  }

  const categoryMap: Record<string, string> = {};
  for (let i = 0; i < categoryNames.length; i++) {
    const name = categoryNames[i];
    const slug = slugify(name);
    const id = makeId();
    await prisma.category.upsert({
      where: { slug },
      update: {},
      create: { id, slug, nameEn: name, displayOrder: i, isActive: true },
    });
    const row = await prisma.category.findUnique({ where: { slug } });
    categoryMap[name] = row!.id;
    console.log(`Cat: ${name}`);
  }

  // --- 2. Build all data in memory, then batch insert ---
  const productRows: any[] = [];
  const optionRows: any[] = [];
  const optionValueRows: any[] = [];
  const variantRows: any[] = [];

  const usedSlugs = new Set<string>();

  for (let pi = 0; pi < products.length; pi++) {
    const p = products[pi];
    const nameEn: string = p.name;
    let slug = slugify(nameEn);
    // Deduplicate slug
    if (usedSlugs.has(slug)) slug = `${slug}-${p.listing_id}`;
    usedSlugs.add(slug);

    const basePrice = Math.round((p.original_price_inr_from ?? p.price_inr_from) * 100);
    const salePricePaise = p.price_inr_from ? Math.round(p.price_inr_from * 100) : null;
    const baseSalePrice = salePricePaise && salePricePaise < basePrice ? salePricePaise : null;

    const productId = `p${p.listing_id}`;

    productRows.push({
      id: productId,
      slug,
      status: 'active',
      nameEn,
      nameSearch: nameEn.toLowerCase(),
      descriptionEn: p.description ?? '',
      categoryId: categoryMap[p.category],
      tags: JSON.stringify([p.category]),
      searchText: nameEn.toLowerCase(),
      basePrice,
      baseSalePrice,
      displayOrder: pi,
    });

    // Size variants
    const sizeGroup = Array.isArray(p.variants)
      ? p.variants.find((v: any) => v.label === 'Size')
      : null;
    const sizeOptions: string[] = sizeGroup
      ? sizeGroup.options.filter(
          (opt: string) => opt !== 'Select an option' && parsePriceFromLabel(opt) !== null,
        )
      : [];

    if (sizeOptions.length === 0) {
      // Default variant, no option
      variantRows.push({
        id: makeId(),
        productId,
        sku: `${p.listing_id}-default`,
        options: '{}',
        price: baseSalePrice ?? basePrice,
        stock: p.stock_quantity ?? 10,
        position: 0,
      });
    } else {
      const optionId = makeId();
      optionRows.push({
        id: optionId,
        productId,
        nameEn: 'Size',
        nameHi: 'आकार',
        type: 'button',
        position: 0,
      });

      for (let vi = 0; vi < sizeOptions.length; vi++) {
        const label = sizeOptions[vi];
        const price = parsePriceFromLabel(label)!;
        const valueId = makeId();
        optionValueRows.push({ id: valueId, optionId, labelEn: label, position: vi });
        variantRows.push({
          id: makeId(),
          productId,
          sku: `${p.listing_id}-${vi}`,
          options: JSON.stringify({ [optionId]: valueId }),
          price,
          stock: p.stock_quantity ?? 10,
          position: vi,
        });
      }
    }
  }

  console.log(
    `\nBuilt: ${productRows.length} products, ${optionRows.length} options, ${optionValueRows.length} values, ${variantRows.length} variants`,
  );

  // --- 3. Batch insert (skipDuplicates = safe to re-run) ---
  console.log('Inserting products...');
  await prisma.product.createMany({ data: productRows, skipDuplicates: true });

  console.log('Inserting options...');
  await prisma.productOption.createMany({ data: optionRows, skipDuplicates: true });

  console.log('Inserting option values...');
  // createMany in chunks of 500 to stay under MySQL packet limit
  for (let i = 0; i < optionValueRows.length; i += 500) {
    await prisma.productOptionValue.createMany({ data: optionValueRows.slice(i, i + 500), skipDuplicates: true });
    console.log(`  values ${i + 1}–${Math.min(i + 500, optionValueRows.length)}`);
  }

  console.log('Inserting variants...');
  for (let i = 0; i < variantRows.length; i += 500) {
    await prisma.productVariant.createMany({ data: variantRows.slice(i, i + 500), skipDuplicates: true });
    console.log(`  variants ${i + 1}–${Math.min(i + 500, variantRows.length)}`);
  }

  console.log('\nDone!');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
