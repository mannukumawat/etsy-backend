import { Router } from 'express';
import multer from 'multer';
import * as XLSX from 'xlsx';
import * as crypto from 'crypto';
import { prisma } from '../db.js';
import { requireOwner } from '../auth.js';
import { route, badRequest } from '../http.js';

export const importExportRouter = Router();
importExportRouter.use(requireOwner);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function makeId() { return crypto.randomBytes(12).toString('hex'); }

function slugify(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 80);
}

function parsePriceFromLabel(label: string): number | null {
  const m = label.match(/₹\s*([\d,]+)/);
  if (!m) return null;
  return parseInt(m[1].replace(/,/g, ''), 10) * 100;
}

// ---------------------------------------------------------------------------
// GET /api/admin/products/export  — download current products as Excel
// ---------------------------------------------------------------------------
importExportRouter.get(
  '/products/export',
  route(async (_req, res) => {
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

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="products-export.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  }),
);

// ---------------------------------------------------------------------------
// POST /api/admin/products/import  — upload Excel, bulk-insert products
// ---------------------------------------------------------------------------
importExportRouter.post(
  '/products/import',
  upload.single('file'),
  route(async (req, res) => {
    if (!req.file) throw badRequest('No file uploaded.');

    let wb: XLSX.WorkBook;
    try {
      wb = XLSX.read(req.file.buffer, { type: 'buffer' });
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
      const id = makeId();
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
      if (usedSlugs.has(slug)) slug = `${slug}-${makeId().slice(0, 6)}`;
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
      const productId = `pi-${makeId()}`;

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
          id: makeId(),
          productId,
          sku: `imp-${productId}-default`,
          options: '{}',
          price: Math.round(priceVal * 100) || basePrice,
          stock: stockVal,
          position: 0,
        });
      } else {
        const optionId = makeId();
        optionRows.push({ id: optionId, productId, nameEn: 'Size', nameHi: 'आकार', type: 'button', position: 0 });

        for (let vi = 0; vi < sizeRows.length; vi++) {
          const sr = sizeRows[vi];
          const label = String(sr['size_label']).trim();
          const priceInr = Number(sr['size_price_inr'] ?? 0);
          const parsedFromLabel = parsePriceFromLabel(label);
          const pricePaise = parsedFromLabel ?? (priceInr ? Math.round(priceInr * 100) : basePrice);
          const stockVal = Number(sr['stock'] ?? 10);
          const valueId = makeId();

          optionValueRows.push({ id: valueId, optionId, labelEn: label, position: vi });
          variantRows.push({
            id: makeId(),
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await prisma.product.createMany({ data: productRows as any[], skipDuplicates: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await prisma.productOption.createMany({ data: optionRows as any[], skipDuplicates: true });

    for (let i = 0; i < optionValueRows.length; i += 500) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await prisma.productOptionValue.createMany({ data: optionValueRows.slice(i, i + 500) as any[], skipDuplicates: true });
    }
    for (let i = 0; i < variantRows.length; i += 500) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await prisma.productVariant.createMany({ data: variantRows.slice(i, i + 500) as any[], skipDuplicates: true });
    }

    res.json({
      imported: productRows.length,
      categories: catMap.size,
      variants: variantRows.length,
    });
  }),
);
