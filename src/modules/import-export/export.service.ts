import * as XLSX from 'xlsx';
import { prisma } from '../../shared/database/prisma.js';

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
    { column: 'product_name', required: 'YES', description: 'Product name. Same name on multiple rows = same product with multiple sizes.' },
    { column: 'category', required: 'YES', description: 'Category name. Auto-created if does not exist. E.g. Kilim Rug, Jute Rug, Cushion Cover' },
    { column: 'description', required: 'no', description: 'Short product description.' },
    { column: 'mrp_inr', required: 'YES', description: 'Maximum Retail Price in INR (without rupee symbol). E.g. 15739' },
    { column: 'sale_inr', required: 'no', description: 'Sale/current price in INR. Leave blank if same as MRP.' },
    { column: 'stock', required: 'no', description: 'Stock quantity for this size. Default 10 if blank.' },
    { column: 'size_label', required: 'no', description: 'Size option label. E.g. "2x3 Ft Kilim Rug (₹ 4,407)". Leave blank if no sizes.' },
    { column: 'size_price_inr', required: 'no', description: 'Price for this size in INR. Used if no ₹ found in size_label.' },
  ];
  const wsi = XLSX.utils.json_to_sheet(instructions);
  wsi['!cols'] = [{ wch: 18 }, { wch: 10 }, { wch: 70 }];
  XLSX.utils.book_append_sheet(wb, wsi, 'Instructions');

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/** Current catalog as an Excel workbook in the same column layout the import reads. */
export async function exportProductsWorkbook(): Promise<Buffer> {
  const products = await prisma.product.findMany({
    include: {
      category: true,
      options: { include: { values: { orderBy: { position: 'asc' } } }, orderBy: { position: 'asc' } },
      variants: { orderBy: { position: 'asc' } },
    },
    orderBy: { displayOrder: 'asc' },
  });

  const rows: Record<string, unknown>[] = [];

  for (const p of products) {
    const sizeOption = p.options.find((o) => o.nameEn === 'Size');
    if (!sizeOption || sizeOption.values.length === 0) {
      const v = p.variants[0];
      rows.push({
        product_name: p.nameEn,
        category: p.category.nameEn,
        description: p.descriptionEn,
        mrp_inr: Math.round(p.basePrice / 100),
        sale_inr: p.baseSalePrice ? Math.round(p.baseSalePrice / 100) : '',
        stock: v?.stock ?? 0,
        size_label: '',
        size_price_inr: v ? Math.round(v.price / 100) : Math.round(p.basePrice / 100),
      });
    } else {
      for (const val of sizeOption.values) {
        const variant = p.variants.find((v) => {
          try { const opts = JSON.parse(v.options); return opts[sizeOption.id] === val.id; } catch { return false; }
        });
        rows.push({
          product_name: p.nameEn,
          category: p.category.nameEn,
          description: p.descriptionEn,
          mrp_inr: Math.round(p.basePrice / 100),
          sale_inr: p.baseSalePrice ? Math.round(p.baseSalePrice / 100) : '',
          stock: variant?.stock ?? 0,
          size_label: val.labelEn,
          size_price_inr: variant ? Math.round(variant.price / 100) : '',
        });
      }
    }
  }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  // Column widths
  ws['!cols'] = [{ wch: 60 }, { wch: 20 }, { wch: 40 }, { wch: 12 }, { wch: 12 }, { wch: 8 }, { wch: 30 }, { wch: 16 }];
  XLSX.utils.book_append_sheet(wb, ws, 'Products');

  // Template sheet
  const templateRows = [{
    product_name: 'Example Product Name',
    category: 'Kilim Rug',
    description: 'Short description of product',
    mrp_inr: 10000,
    sale_inr: 7000,
    stock: 5,
    size_label: '2x3 Ft Kilim Rug (₹ 7,000)',
    size_price_inr: 7000,
  }];
  const wst = XLSX.utils.json_to_sheet(templateRows);
  wst['!cols'] = ws['!cols'];
  XLSX.utils.book_append_sheet(wb, wst, 'Template');

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
