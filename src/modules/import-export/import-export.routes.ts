import { Router } from 'express';
import multer from 'multer';
import { badRequest } from '../../shared/errors/http-error.js';
import { route } from '../../shared/http/async-route.js';
import { requireOwner } from '../../shared/middleware/auth.middleware.js';
import { buildProductImportTemplate, exportProductsWorkbook } from './export.service.js';
import { importProductsFromWorkbook } from './import.service.js';

export const importExportRouter = Router();
importExportRouter.use(requireOwner);

const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// ---------------------------------------------------------------------------
// GET /api/admin/products/template  — download blank Excel template
// ---------------------------------------------------------------------------
importExportRouter.get(
  '/products/template',
  route(async (_req, res) => {
    const buf = buildProductImportTemplate();
    res.setHeader('Content-Disposition', 'attachment; filename="product-import-template.xlsx"');
    res.setHeader('Content-Type', XLSX_CONTENT_TYPE);
    res.send(buf);
  }),
);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ---------------------------------------------------------------------------
// GET /api/admin/products/export  — download current products as Excel
// ---------------------------------------------------------------------------
importExportRouter.get(
  '/products/export',
  route(async (_req, res) => {
    const buf = await exportProductsWorkbook();
    res.setHeader('Content-Disposition', 'attachment; filename="products-export.xlsx"');
    res.setHeader('Content-Type', XLSX_CONTENT_TYPE);
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
    res.json(await importProductsFromWorkbook(req.file.buffer));
  }),
);
