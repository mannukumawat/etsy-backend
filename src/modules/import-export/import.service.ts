import * as XLSX from 'xlsx';
import { prisma } from '../../shared/database/prisma.js';
import { badRequest } from '../../shared/errors/http-error.js';
import { randomHexId } from '../../shared/utils/ids.js';

function slugify(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 80);
}

function parsePriceFromLabel(label: string): number | null {
  const m = label.match(/₹\s*([\d,]+)/);
  if (!m) return null;
  return parseInt(m[1].replace(/,/g, ''), 10) * 100;
}

/** Bulk-inserts the products in an uploaded Excel workbook (first sheet; rows sharing a product_name
 *  become one product with one size option/variant per row). Categories are created on demand. */
export async function importProductsFromWorkbook(fileBuffer: Buffer) {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(fileBuffer, { type: 'buffer' });
  } catch {
    throw badRequest('Could not parse Excel file.');
  }

  const sheetName = wb.SheetNames[0];
  const rows: Record<string, unknown>[] = XLSX.utils.sheet_to_json(wb.Sheets[sheetName]);

  if (rows.length === 0) throw badRequest('Excel sheet is empty.');

  // Group rows by product_name
  const grouped = new Map<string, typeof rows>();
  for (const row of rows) {
    const name = String(row['product_name'] ?? '').trim();
    if (!name) continue;
    if (!grouped.has(name)) grouped.set(name, []);
    grouped.get(name)!.push(row);
  }

  // Collect categories
  const catNames = new Set<string>();
  for (const [, productRows] of grouped) {
    const cat = String(productRows[0]['category'] ?? '').trim();
    if (cat) catNames.add(cat);
  }

  // Upsert categories
  const catMap = new Map<string, string>();
  let catOrder = await prisma.category.count();
  for (const name of catNames) {
    const slug = slugify(name);
    const id = randomHexId(12);
    await prisma.category.upsert({
      where: { slug },
      update: {},
      create: { id, slug, nameEn: name, displayOrder: catOrder++, isActive: true },
    });
    const row = await prisma.category.findUnique({ where: { slug } });
    catMap.set(name, row!.id);
  }

  const productRows: Record<string, unknown>[] = [];
  const optionRows: Record<string, unknown>[] = [];
  const optionValueRows: Record<string, unknown>[] = [];
  const variantRows: Record<string, unknown>[] = [];

  const usedSlugs = new Set<string>(
    (await prisma.product.findMany({ select: { slug: true } })).map((p) => p.slug),
  );
  let displayOrder = await prisma.product.count();

  for (const [nameEn, productRowList] of grouped) {
    let slug = slugify(nameEn);
    if (usedSlugs.has(slug)) slug = `${slug}-${randomHexId(12).slice(0, 6)}`;
    usedSlugs.add(slug);

    const firstRow = productRowList[0];
    const catName = String(firstRow['category'] ?? '').trim();
    const categoryId = catMap.get(catName) ?? (await prisma.category.findFirst({ where: { nameEn: catName } }))?.id;
    if (!categoryId) continue;

    const mrp = Number(firstRow['mrp_inr'] ?? 0);
    const sale = Number(firstRow['sale_inr'] ?? 0);
    const basePrice = Math.round(mrp * 100) || 100;
    const baseSalePrice = sale && sale < mrp ? Math.round(sale * 100) : null;
    const description = String(firstRow['description'] ?? '');
    const productId = `pi-${randomHexId(12)}`;

    productRows.push({
      id: productId,
      slug,
      status: 'active',
      nameEn,
      nameSearch: nameEn.toLowerCase(),
      descriptionEn: description,
      categoryId,
      tags: JSON.stringify([catName]),
      searchText: nameEn.toLowerCase(),
      basePrice,
      baseSalePrice,
      displayOrder: displayOrder++,
    });

    // Build size options from rows that have size_label + size_price_inr
    const sizeRows = productRowList.filter((r) => String(r['size_label'] ?? '').trim());

    if (sizeRows.length === 0) {
      const stockVal = Number(firstRow['stock'] ?? 10);
      const priceVal = Number(firstRow['size_price_inr'] ?? mrp);
      variantRows.push({
        id: randomHexId(12),
        productId,
        sku: `imp-${productId}-default`,
        options: '{}',
        price: Math.round(priceVal * 100) || basePrice,
        stock: stockVal,
        position: 0,
      });
    } else {
      const optionId = randomHexId(12);
      optionRows.push({ id: optionId, productId, nameEn: 'Size', nameHi: 'आकार', type: 'button', position: 0 });

      for (let vi = 0; vi < sizeRows.length; vi++) {
        const sr = sizeRows[vi];
        const label = String(sr['size_label']).trim();
        const priceInr = Number(sr['size_price_inr'] ?? 0);
        const parsedFromLabel = parsePriceFromLabel(label);
        const pricePaise = parsedFromLabel ?? (priceInr ? Math.round(priceInr * 100) : basePrice);
        const stockVal = Number(sr['stock'] ?? 10);
        const valueId = randomHexId(12);

        optionValueRows.push({ id: valueId, optionId, labelEn: label, position: vi });
        variantRows.push({
          id: randomHexId(12),
          productId,
          sku: `imp-${productId}-${vi}`,
          options: JSON.stringify({ [optionId]: valueId }),
          price: pricePaise,
          stock: stockVal,
          position: vi,
        });
      }
    }
  }

  // Batch insert (any[] cast: rows are built with exact required fields above)
  await prisma.product.createMany({ data: productRows as any[], skipDuplicates: true });
  await prisma.productOption.createMany({ data: optionRows as any[], skipDuplicates: true });

  for (let i = 0; i < optionValueRows.length; i += 500) {
    await prisma.productOptionValue.createMany({ data: optionValueRows.slice(i, i + 500) as any[], skipDuplicates: true });
  }
  for (let i = 0; i < variantRows.length; i += 500) {
    await prisma.productVariant.createMany({ data: variantRows.slice(i, i + 500) as any[], skipDuplicates: true });
  }

  return {
    imported: productRows.length,
    categories: catMap.size,
    variants: variantRows.length,
  };
}
