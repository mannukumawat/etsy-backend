import * as XLSX from 'xlsx';
import { prisma } from '../../shared/database/prisma.js';
import { mediaUrl } from '../../shared/config/env.js';
import { badRequest } from '../../shared/errors/http-error.js';
import { convertFromBase } from '../../shared/utils/currency.js';
import { listProductIds } from '../products/product.service.js';
import type { ProductListQuery } from '../products/product.types.js';

/** The INR config used to convert stored USD prices back to INR for export. */
async function loadInrConfig() {
  const inr = await prisma.currencyConfig.findFirst({ where: { code: 'INR' } });
  if (!inr || !Number.isFinite(inr.rate) || inr.rate <= 0) {
    throw badRequest('INR currency rate is not configured. Set the INR rate in Settings → Currencies before exporting.');
  }
  return inr;
}

/** Stored USD minor units → whole INR rupees, at the configured rate. */
function usdMinorToInrRupees(usdMinor: number, inr: { rate: number; fractionDigits: number; roundingIncrement: number }): number {
  return Math.round(convertFromBase(usdMinor, { code: 'INR', rate: inr.rate, fractionDigits: inr.fractionDigits, roundingIncrement: inr.roundingIncrement }) / 100);
}

/** Blank Excel template (sample rows + an Instructions sheet) for the product import. */
export function buildProductImportTemplate(): Buffer {
  const sampleRows = [
    {
      product_name: 'Natural Wool Kilim Rug - Charcoal Geometric',
      category: 'Kilim Rug',
      description: 'Handwoven flatweave rug with kilim styling. Materials: Hemp, jute, wool.',
      mrp_inr: 15739,
      sale_inr: 4407,
      stock: 3,
      size_label: '2x3 Ft Kilim Rug (₹ 4,407)',
      size_price_inr: 4407,
    },
    {
      product_name: 'Natural Wool Kilim Rug - Charcoal Geometric',
      category: 'Kilim Rug',
      description: 'Handwoven flatweave rug with kilim styling. Materials: Hemp, jute, wool.',
      mrp_inr: 15739,
      sale_inr: 4407,
      stock: 3,
      size_label: '4x6 Ft Kilim Rug (₹ 16,353)',
      size_price_inr: 16353,
    },
    {
      product_name: 'Natural Wool Kilim Rug - Charcoal Geometric',
      category: 'Kilim Rug',
      description: 'Handwoven flatweave rug with kilim styling. Materials: Hemp, jute, wool.',
      mrp_inr: 15739,
      sale_inr: 4407,
      stock: 3,
      size_label: '6x9 Ft Kilim Rug (₹ 26,746)',
      size_price_inr: 26746,
    },
    {
      product_name: 'Cotton Yoga Mat - Natural',
      category: 'Cotton Yoga Mat',
      description: 'Handwoven cotton yoga mat, non-slip surface.',
      mrp_inr: 2500,
      sale_inr: 1800,
      stock: 10,
      size_label: '',
      size_price_inr: 1800,
    },
  ];

  const wb = XLSX.utils.book_new();

  // --- Products sheet ---
  const ws = XLSX.utils.json_to_sheet(sampleRows);
  ws['!cols'] = [
    { wch: 50 }, { wch: 20 }, { wch: 45 },
    { wch: 12 }, { wch: 12 }, { wch: 8 },
    { wch: 35 }, { wch: 16 },
  ];
  XLSX.utils.book_append_sheet(wb, ws, 'Products');

  // --- Instructions sheet ---
  const instructions = [
    { column: 'product_name', required: 'YES', description: 'Product name. Same name on multiple rows = same product with multiple sizes. Matching is case-insensitive.' },
    { column: 'category', required: 'YES', description: 'Category name. Auto-created if does not exist. E.g. Kilim Rug, Jute Rug, Cushion Cover' },
    { column: 'description', required: 'no', description: 'Short product description.' },
    { column: 'mrp_inr', required: 'YES', description: 'Maximum Retail Price in INR (without rupee symbol). E.g. 15739. Converted to USD at the store\'s configured INR rate on import — ₹15,739 is about $157 at rate 100, not $15,739.' },
    { column: 'sale_inr', required: 'no', description: 'Sale/current price in INR. Leave blank if same as MRP. Must be lower than MRP.' },
    { column: 'stock', required: 'no', description: 'Stock quantity for this size. Default 10 if blank. Must be a whole number of 0 or more.' },
    { column: 'size_label', required: 'no', description: 'Size option label. E.g. "2x3 Ft Kilim Rug". A ₹ price in the label is display text only — it never sets the price.' },
    { column: 'size_price_inr', required: 'no', description: 'Price for this size in INR. ALWAYS wins over any price written in the size label; falls back to mrp_inr when blank.' },
    { column: '—', required: '—', description: 'Imports are saved as DRAFTS: add images and a short description in the product editor, then activate. Re-importing the same product updates it instead of creating a duplicate. Rows with errors are skipped and listed in the import report.' },
  ];
  const wsi = XLSX.utils.json_to_sheet(instructions);
  wsi['!cols'] = [{ wch: 18 }, { wch: 10 }, { wch: 70 }];
  XLSX.utils.book_append_sheet(wb, wsi, 'Instructions');

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/**
 * Current catalog as an Excel workbook (H6). One row per variant, with the 8 import
 * columns FIRST (so the file re-imports to the same prices/stock/sizes) followed by
 * every field the old export dropped — slug, SKU, status, all options (not just
 * "Size"), images, tags, SEO, materials/care, specs, flags, weight/dimensions,
 * display order, item group/nav link and returns settings. Extra columns are ignored
 * by the import, so the round-trip is safe: the core columns reproduce the product,
 * the rest is reference data for the owner.
 * With `filters` (the admin list's current filters) only the filtered set is
 * exported — the old unfiltered `findMany` is gone. Prices are stored in USD minor
 * units and converted BACK to INR rupees at the configured rate, so an exported file
 * re-imports to the same prices.
 */
export async function exportProductsWorkbook(filters?: ProductListQuery): Promise<Buffer> {
  const inr = await loadInrConfig();
  const ids = filters ? await listProductIds(filters) : null;
  const products = await prisma.product.findMany({
    where: ids ? { id: { in: ids } } : {},
    include: {
      category: true,
      itemGroup: { select: { nameEn: true } },
      navLink: { select: { labelEn: true } },
      collection: { select: { titleEn: true } },
      options: { include: { values: { orderBy: { position: 'asc' } } }, orderBy: { position: 'asc' } },
      variants: { orderBy: { position: 'asc' } },
      images: { orderBy: { position: 'asc' } },
      specs: { orderBy: { position: 'asc' } },
    },
    orderBy: { displayOrder: 'asc' },
  });

  // Image URLs in one query (no per-row/per-product lookup): Cloudinary URL when the
  // media lives there, otherwise the stable /media/:id URL.
  const mediaIds = [...new Set(products.flatMap((p) => p.images.map((i) => i.mediaId)))];
  const mediaRows = mediaIds.length
    ? await prisma.media.findMany({ where: { id: { in: mediaIds } }, select: { id: true, cloudinaryUrl: true } })
    : [];
  const mediaUrlById = new Map(mediaRows.map((m) => [m.id, m.cloudinaryUrl ?? mediaUrl(m.id)]));

  const rows: Record<string, unknown>[] = [];

  for (const p of products) {
    const sizeOption = p.options.find((o) => o.nameEn === 'Size');
    const optionText = (variantOptionsJson: string) => {
      let parsed: Record<string, string> = {};
      try { parsed = JSON.parse(variantOptionsJson) as Record<string, string>; } catch { parsed = {}; }
      return p.options
        .map((o) => {
          const value = o.values.find((v) => v.id === parsed[o.id]);
          return value ? `${o.nameEn}: ${value.labelEn}` : null;
        })
        .filter((x): x is string => !!x)
        .join('; ');
    };
    const base: Record<string, unknown> = {
      slug: p.slug,
      status: p.status,
      tags: p.tags ? JSON.parse(p.tags).join(', ') : '',
      images: p.images.map((i) => mediaUrlById.get(i.mediaId) ?? '').filter(Boolean).join('; '),
      seo_title: p.seoTitleEn,
      seo_description: p.seoDescriptionEn,
      materials: p.materialsEn,
      care: p.careEn,
      specs: p.specs.map((s) => `${s.labelEn}: ${s.valueEn}`).join('; '),
      is_featured: p.isFeatured ? 'yes' : '',
      is_bestseller: p.isBestseller ? 'yes' : '',
      is_new: p.isNew ? 'yes' : '',
      weight_g: p.weightUnit === 'kg' ? p.weightValue * 1000 : p.weightValue,
      length_cm: p.dimLength,
      width_cm: p.dimWidth,
      height_cm: p.dimHeight,
      display_order: p.displayOrder,
      item_group: p.itemGroup?.nameEn ?? '',
      nav_link: p.navLink?.labelEn ?? '',
      collection: p.collection?.titleEn ?? '',
      barcode: p.barcode ?? '',
      cost_price_usd: p.costPrice != null ? (p.costPrice / 100).toFixed(2) : '',
      returns_allowed: p.returnsAllowed ? 'yes' : 'no',
      exchange_allowed: p.exchangeAllowed ? 'yes' : 'no',
      return_days: p.returnDays,
    };
    const variantRows = p.variants.length ? p.variants : [null];
    for (const v of variantRows) {
      const sizeValue = v && sizeOption ? sizeOption.values.find((val) => {
        try { return JSON.parse(v.options)[sizeOption.id] === val.id; } catch { return false; }
      }) : undefined;
      rows.push({
        product_name: p.nameEn,
        category: p.category.nameEn,
        description: p.descriptionEn,
        mrp_inr: usdMinorToInrRupees(p.basePrice, inr),
        sale_inr: p.baseSalePrice ? usdMinorToInrRupees(p.baseSalePrice, inr) : '',
        stock: v?.stock ?? 0,
        size_label: sizeValue?.labelEn ?? '',
        size_price_inr: v ? usdMinorToInrRupees(v.price, inr) : usdMinorToInrRupees(p.basePrice, inr),
        sku: v?.sku ?? '',
        options: v ? optionText(v.options) : '',
        ...base,
      });
    }
  }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  // Column widths: the 8 import columns first, then the reference columns.
  ws['!cols'] = [
    { wch: 50 }, { wch: 20 }, { wch: 45 }, { wch: 12 }, { wch: 12 }, { wch: 8 }, { wch: 35 }, { wch: 16 },
    { wch: 16 }, { wch: 30 }, { wch: 12 }, { wch: 30 }, { wch: 60 }, { wch: 40 }, { wch: 40 }, { wch: 30 },
    { wch: 30 }, { wch: 30 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 },
    { wch: 10 }, { wch: 12 }, { wch: 20 }, { wch: 20 }, { wch: 14 }, { wch: 14 }, { wch: 12 },
  ];
  XLSX.utils.book_append_sheet(wb, ws, 'Products');

  // Instructions sheet (replaces the old single-row Template sheet): the first 8
  // columns are the import format; the rest are reference-only on re-import.
  const instructions = [
    { column: 'product_name … size_price_inr', required: 'YES', description: 'The import format — re-importing this file reproduces the products (prices, stock, sizes). Same name on multiple rows = same product.' },
    { column: 'slug', required: '—', description: 'Reference only on re-import (the import matches products by name and keeps the existing slug).' },
    { column: 'sku', required: '—', description: 'Variant SKU. Reference only — the import generates SKUs from the product name when re-importing.' },
    { column: 'status', required: '—', description: 'draft / active / archived. Reference only — imports are always saved as drafts.' },
    { column: 'options', required: '—', description: 'ALL option values for the variant (e.g. "Colour: Red; Size: 2x3 Ft"), not just Size. Reference only — the import only rebuilds the Size option.' },
    { column: 'images', required: '—', description: 'Image URLs (semicolon-separated). Reference only — the import does not set images.' },
    { column: 'tags / seo_title / seo_description / materials / care / specs', required: '—', description: 'Reference only — the import only reads the short description.' },
    { column: 'is_featured / is_bestseller / is_new / weight_g / length_cm / width_cm / height_cm / display_order / item_group / nav_link / returns_allowed / exchange_allowed / return_days', required: '—', description: 'Reference only — kept in the export so nothing is lost, but not read back by the import.' },
  ];
  const wsi = XLSX.utils.json_to_sheet(instructions);
  wsi['!cols'] = [{ wch: 60 }, { wch: 10 }, { wch: 90 }];
  XLSX.utils.book_append_sheet(wb, wsi, 'Instructions');

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
