import * as XLSX from 'xlsx';
import { prisma } from '../../shared/database/prisma.js';
import { badRequest } from '../../shared/errors/http-error.js';
import { randomHexId } from '../../shared/utils/ids.js';
import { buildProductSearchText } from '../products/product-search.js';
import { productInputSchema } from '../products/product.schema.js';
import {
  cellString,
  inrRupeesToUsdMinor,
  normalizeProductName,
  parseNumberCell,
  parseStockCell,
  productGroupKey,
  slugify,
  type ImportRowError,
} from './import-format.js';

export interface ImportResult {
  imported: number;
  /** Re-imports that updated the existing product instead of creating a duplicate. */
  updated: number;
  /** Product groups skipped because of validation errors (see `errors`). */
  skipped: number;
  categories: number;
  variants: number;
  errors: ImportRowError[];
}

interface ParsedRow {
  /** 1-based Excel row number (row 1 is the header). */
  excelRow: number;
  name: string;
  category: string;
  description: string;
  mrpInr: number;
  saleInr: number | null;
  stock: number | null;
  sizeLabel: string;
  sizePriceInr: number | null;
}

const DEFAULT_STOCK = 10;

/**
 * Bulk-imports the products in an uploaded Excel workbook (first sheet; rows sharing a
 * product_name — case-insensitive, trimmed — become one product with one size
 * option/variant per row). Categories are created on demand.
 *
 * Currency: the file speaks INR; the database stores USD minor units. Every price is
 * converted at the store's configured INR rate (1 USD = rate INR) — a ₹15,739 MRP
 * becomes $157.39 at rate 100, never $15,739.
 *
 * Validation: every row is validated (blank name, bad MRP/stock, sale ≥ MRP all produce
 * per-row errors instead of silent coercion); every product is validated with
 * productInputSchema. New products are always created as `draft` — an import has no
 * images or short description, so it can never pass the activation rules. Re-importing
 * the same product_name/slug UPDATES the existing product (same id, options/variants
 * rebuilt); it never creates a duplicate.
 *
 * Atomicity: all writes run in one transaction — a failure anywhere rolls the whole
 * import back. Per-row errors only skip that product; the rest still import.
 */
export async function importProductsFromWorkbook(fileBuffer: Buffer): Promise<ImportResult> {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(fileBuffer, { type: 'buffer' });
  } catch {
    throw badRequest('Could not parse Excel file.');
  }

  const sheetName = wb.SheetNames[0];
  const rawRows: Record<string, unknown>[] = XLSX.utils.sheet_to_json(wb.Sheets[sheetName]);

  if (rawRows.length === 0) throw badRequest('Excel sheet is empty.');

  // The INR rate is the single source of truth for every price in the file. Without a
  // configured rate there is no safe conversion, so refuse the import outright.
  const inrConfig = await prisma.currencyConfig.findFirst({ where: { code: 'INR' } });
  const inrRate = inrConfig?.rate;
  if (!inrRate || !Number.isFinite(inrRate) || inrRate <= 0) {
    throw badRequest('INR currency rate is not configured. Set the INR rate in Settings → Currencies before importing.');
  }

  const errors: ImportRowError[] = [];
  // Groups poisoned by any bad row: the whole product is skipped (with its row
  // errors reported), never partially imported from the surviving rows.
  const poisonedKeys = new Set<string>();

  // --- Phase 1: validate every row's cells (row numbers included in every error). ---
  const parsed: ParsedRow[] = [];
  for (let i = 0; i < rawRows.length; i++) {
    const row = rawRows[i];
    const excelRow = i + 2; // header is row 1
    const name = normalizeProductName(cellString(row, 'product_name'));
    if (!name) {
      errors.push({ row: excelRow, field: 'product_name', message: 'Product name is required.' });
      continue;
    }
    const poison = (field: string, message: string) => {
      errors.push({ row: excelRow, field, message });
      poisonedKeys.add(productGroupKey(name));
    };
    const category = cellString(row, 'category');
    if (!category) {
      poison('category', 'Category is required.');
      continue;
    }
    const mrpParsed = parseNumberCell(row['mrp_inr']);
    if ('error' in mrpParsed) {
      poison('mrp_inr', `MRP ${mrpParsed.error}`);
      continue;
    }
    if (mrpParsed.value === null || mrpParsed.value <= 0) {
      poison('mrp_inr', 'MRP must be a number above zero.');
      continue;
    }
    const saleParsed = parseNumberCell(row['sale_inr']);
    if ('error' in saleParsed) {
      poison('sale_inr', `Sale price ${saleParsed.error}`);
      continue;
    }
    if (saleParsed.value !== null && saleParsed.value < 0) {
      poison('sale_inr', 'Sale price cannot be negative.');
      continue;
    }
    const stockParsed = parseStockCell(row['stock']);
    if ('error' in stockParsed) {
      poison('stock', stockParsed.error);
      continue;
    }
    const sizePriceParsed = parseNumberCell(row['size_price_inr']);
    if ('error' in sizePriceParsed) {
      poison('size_price_inr', `Size price ${sizePriceParsed.error}`);
      continue;
    }
    if (sizePriceParsed.value !== null && sizePriceParsed.value < 0) {
      poison('size_price_inr', 'Size price cannot be negative.');
      continue;
    }
    parsed.push({
      excelRow,
      name,
      category,
      description: cellString(row, 'description'),
      mrpInr: mrpParsed.value,
      saleInr: saleParsed.value,
      stock: stockParsed.value,
      sizeLabel: cellString(row, 'size_label'),
      sizePriceInr: sizePriceParsed.value,
    });
  }

  // --- Phase 2: group rows into products (case-insensitive name). ---
  const grouped = new Map<string, ParsedRow[]>();
  for (const r of parsed) {
    const key = productGroupKey(r.name);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(r);
  }

  const [existingCategories, existingProducts] = await Promise.all([
    prisma.category.findMany({ select: { id: true, slug: true, nameEn: true, isActive: true } }),
    prisma.product.findMany({ select: { id: true, slug: true, status: true } }),
  ]);
  const categoryBySlug = new Map(existingCategories.map((c) => [c.slug, c]));
  const productBySlug = new Map(existingProducts.map((p) => [p.slug, p]));
  const plannedSlugs = new Set<string>();
  let displayOrder = await prisma.product.count();

  // Planned writes, built only for groups that pass every check.
  const newCategoryRows: Array<{ id: string; slug: string; nameEn: string; displayOrder: number }> = [];
  const categoryIdByName = new Map<string, string>();
  for (const c of existingCategories) categoryIdByName.set(c.nameEn.toLowerCase(), c.id);
  let categoryOrder = existingCategories.length;
  const productCreates: Record<string, unknown>[] = [];
  const productUpdates: Array<{ id: string; data: Record<string, unknown> }> = [];
  const optionRows: Record<string, unknown>[] = [];
  const optionValueRows: Record<string, unknown>[] = [];
  const variantRows: Record<string, unknown>[] = [];
  let imported = 0;
  let updated = 0;
  let skipped = 0;
  let variantCount = 0;

  for (const [key, productRows] of grouped) {
    const firstRow = productRows[0];
    // Any row of this product failed validation → skip the whole product. The
    // row errors are already in `errors`; nothing more to explain.
    if (poisonedKeys.has(key)) {
      skipped++;
      continue;
    }
    const nameEn = firstRow.name;
    const slug = slugify(nameEn);
    if (!slug) {
      errors.push({ row: firstRow.excelRow, field: 'product_name', message: 'Product name does not produce a valid slug.' });
      skipped++;
      continue;
    }
    if (plannedSlugs.has(slug)) {
      errors.push({ row: firstRow.excelRow, field: 'product_name', message: `Another product in this file already uses the slug '${slug}'.` });
      skipped++;
      continue;
    }
    plannedSlugs.add(slug);

    // Category: first row's category only; must exist-and-active or be auto-created.
    const catName = firstRow.category;
    const catSlug = slugify(catName);
    const category = categoryBySlug.get(catSlug);
    if (category && !category.isActive) {
      errors.push({ row: firstRow.excelRow, field: 'category', message: `Category '${catName}' is not active.` });
      skipped++;
      continue;
    }
    let categoryId: string;
    if (category) {
      categoryId = category.id;
    } else if (categoryIdByName.has(catName.toLowerCase())) {
      categoryId = categoryIdByName.get(catName.toLowerCase())!;
    } else {
      categoryId = randomHexId(12);
      newCategoryRows.push({ id: categoryId, slug: catSlug, nameEn: catName, displayOrder: categoryOrder++ });
      categoryIdByName.set(catName.toLowerCase(), categoryId);
      categoryBySlug.set(catSlug, { id: categoryId, slug: catSlug, nameEn: catName, isActive: true });
    }

    // Prices: INR rupees → USD minor units at the configured rate.
    const basePrice = inrRupeesToUsdMinor(firstRow.mrpInr, inrRate);
    if (basePrice <= 0) {
      errors.push({ row: firstRow.excelRow, field: 'mrp_inr', message: 'MRP converts to $0.00 at the current INR rate.' });
      skipped++;
      continue;
    }
    let baseSalePrice: number | null = null;
    if (firstRow.saleInr !== null) {
      if (firstRow.saleInr >= firstRow.mrpInr) {
        errors.push({ row: firstRow.excelRow, field: 'sale_inr', message: 'Sale price must be lower than the MRP.' });
        skipped++;
        continue;
      }
      baseSalePrice = inrRupeesToUsdMinor(firstRow.saleInr, inrRate);
    }

    const existing = productBySlug.get(slug);
    const productId = existing?.id ?? `pi-${randomHexId(12)}`;
    const isUpdate = Boolean(existing);

    // Build options/variants from the size rows.
    const sizeRows = productRows.filter((r) => r.sizeLabel);
    const options: Array<{ id: string; name: { en: string; hi: string }; type: 'button'; values: Array<{ id: string; label: { en: string; hi: string } }> }> = [];
    const variants: Array<{ id: string; sku: string; options: Record<string, string>; price: number; salePrice: number | null; stock: number; imageIds: string[] }> = [];
    if (sizeRows.length === 0) {
      const priceInr = firstRow.sizePriceInr ?? firstRow.mrpInr;
      variants.push({
        id: randomHexId(12),
        sku: `imp-${productId}-default`,
        options: {},
        price: inrRupeesToUsdMinor(priceInr, inrRate),
        salePrice: null,
        stock: firstRow.stock ?? DEFAULT_STOCK,
        imageIds: [],
      });
    } else {
      const optionId = randomHexId(12);
      const values: Array<{ id: string; label: { en: string; hi: string } }> = [];
      for (let vi = 0; vi < sizeRows.length; vi++) {
        const sr = sizeRows[vi];
        // M-P5: size_price_inr ALWAYS wins. The old quirk (a ₹ price embedded in the
        // size label overriding the column) is gone: it was undocumented, surprising,
        // and made the same file import differently depending on label text. A ₹ price
        // in the label is now display text only. The template Instructions say so.
        const priceInr = sr.sizePriceInr ?? firstRow.mrpInr;
        const valueId = randomHexId(12);
        values.push({ id: valueId, label: { en: sr.sizeLabel, hi: '' } });
        variants.push({
          id: randomHexId(12),
          sku: `imp-${productId}-${vi}`,
          options: { [optionId]: valueId },
          price: inrRupeesToUsdMinor(priceInr, inrRate),
          salePrice: null,
          stock: sr.stock ?? DEFAULT_STOCK,
          imageIds: [],
        });
      }
      options.push({ id: optionId, name: { en: 'Size', hi: 'आकार' }, type: 'button', values });
    }

    // Validate the whole product with the same schema the product editor uses. Imports
    // are always drafts (no images / short description, so activation can never pass);
    // re-imports keep the existing product's status.
    const input = {
      slug,
      status: 'draft' as const,
      name: { en: nameEn, hi: '' },
      shortDescription: { en: '', hi: '' },
      description: { en: firstRow.description, hi: '' },
      categoryId,
      tags: [catName],
      basePrice,
      baseSalePrice,
      images: [],
      materials: { en: '', hi: '' },
      care: { en: '', hi: '' },
      options,
      variants,
    };
    const check = productInputSchema.safeParse(input);
    if (!check.success) {
      for (const issue of check.error.issues) {
        errors.push({
          row: firstRow.excelRow,
          field: String(issue.path[0] ?? 'product'),
          message: issue.message,
        });
      }
      skipped++;
      continue;
    }

    const productData = {
      slug,
      nameEn,
      nameSearch: nameEn.toLowerCase(),
      descriptionEn: firstRow.description,
      categoryId,
      tags: JSON.stringify([catName]),
      // Same haystack as product save (name + slug + tags + SKUs) so imports are searchable.
      searchText: buildProductSearchText([nameEn, slug, catName, variants.map((v) => v.sku).join(' ')]),
      basePrice,
      baseSalePrice,
    };
    if (isUpdate) {
      productUpdates.push({ id: productId, data: productData });
      updated++;
    } else {
      productCreates.push({ id: productId, ...productData, status: 'draft', displayOrder: displayOrder++ });
      imported++;
    }

    if (options.length) {
      for (const o of options) {
        optionRows.push({ id: o.id, productId, nameEn: o.name.en, nameHi: o.name.hi, type: o.type, position: 0 });
        for (const [vi, v] of o.values.entries()) {
          optionValueRows.push({ id: v.id, optionId: o.id, labelEn: v.label.en, position: vi });
        }
      }
    }
    for (const [vi, v] of variants.entries()) {
      variantRows.push({
        id: v.id,
        productId,
        sku: v.sku,
        options: JSON.stringify(v.options),
        price: v.price,
        stock: v.stock,
        position: vi,
      });
    }
    variantCount += variants.length;
  }

  // Poisoned products whose every row failed never formed a group above — count them too.
  for (const key of poisonedKeys) {
    if (!grouped.has(key)) skipped++;
  }

  // --- Phase 3: one transaction for every write. Any failure rolls the whole import back. ---
  // Nothing valid to write (every group was skipped) → no transaction at all.
  if (productCreates.length || productUpdates.length || newCategoryRows.length) {
    await prisma.$transaction(async (tx) => {
    for (const c of newCategoryRows) {
      await tx.category.upsert({
        where: { slug: c.slug },
        update: {},
        create: { id: c.id, slug: c.slug, nameEn: c.nameEn, displayOrder: c.displayOrder, isActive: true },
      });
    }
    for (const u of productUpdates) {
      // Rebuild options/variants from the file; images and status are left untouched.
      await tx.productVariant.deleteMany({ where: { productId: u.id } });
      await tx.productOptionValue.deleteMany({ where: { option: { productId: u.id } } });
      await tx.productOption.deleteMany({ where: { productId: u.id } });
      await tx.product.update({ where: { id: u.id }, data: u.data });
    }
    if (productCreates.length) {
      await tx.product.createMany({ data: productCreates as never[] });
    }
    if (optionRows.length) {
      await tx.productOption.createMany({ data: optionRows as never[] });
    }
    for (let i = 0; i < optionValueRows.length; i += 500) {
      await tx.productOptionValue.createMany({ data: optionValueRows.slice(i, i + 500) as never[] });
    }
    for (let i = 0; i < variantRows.length; i += 500) {
      await tx.productVariant.createMany({ data: variantRows.slice(i, i + 500) as never[] });
    }
    });
  }

  return {
    imported,
    updated,
    skipped,
    categories: newCategoryRows.length,
    variants: variantCount,
    // Row order, so the report reads top-to-bottom like the spreadsheet.
    errors: [...errors].sort((a, b) => a.row - b.row),
  };
}
