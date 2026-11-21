import { prisma } from '../../shared/database/prisma.js';
import { badRequest, conflict, notFound } from '../../shared/errors/http-error.js';
import { stringifyJson } from '../../shared/utils/json.js';
import { buildProductSearchQuery, buildProductSearchText } from './product-search.js';
import { adjustmentData } from '../../shared/utils/inventory-adjustments.js';
import { clampPage, pageCountFor } from '../../shared/utils/pagination.js';
import { recordAuditLog } from '../../shared/utils/audit-log.js';
import { PRODUCT_INCLUDE, toAdminProduct } from './product.mapper.js';
import type { ProductInput, ProductListQuery, ProductStatus } from './product.types.js';
import { productInputSchema } from './product.schema.js';
import { assertProductReferencesExist, assertProductSkusAvailable, assertProductSlugAvailable } from './product-reference.service.js';

/**
 * Server-side product list (H16): filters, sort and pagination all happen in the
 * database — the old `take: 500` silent cap is gone. One WHERE builder feeds the count
 * and the page query (same pattern as the C6 orders list), so the two can never disagree
 * about which products match. Stock sorts/filters use total/worst-variant stock from
 * `product_variants`, and the low-stock threshold is the LIVE settings value, not a seed.
 */
function buildProductListWhere(query: ProductListQuery, threshold: number): { sql: string; params: unknown[] } {
  const conds: string[] = ['1 = 1'];
  const params: unknown[] = [];
  if (query.status === 'draft' || query.status === 'active' || query.status === 'archived') {
    conds.push('status = ?');
    params.push(query.status);
  }
  if (query.q) {
    const search = buildProductSearchQuery(query.q);
    if (search.mode === 'fulltext') {
      // MySQL FULLTEXT on the @@fulltext([searchText]) index — the LIKE scan it replaces
      // read every product row. The boolean query is a bound parameter, never interpolated.
      conds.push('MATCH(searchText) AGAINST(? IN BOOLEAN MODE)');
      params.push(search.booleanQuery);
    } else {
      conds.push('searchText LIKE ? ESCAPE \'\\\'');
      params.push(search.pattern);
    }
  }
  if (query.category) {
    conds.push('categoryId = ?');
    params.push(query.category);
  }
  if (query.itemGroup) {
    conds.push('itemGroupId = ?');
    params.push(query.itemGroup);
  }
  if (query.flag === 'featured') conds.push('isFeatured = 1');
  else if (query.flag === 'bestseller') conds.push('isBestseller = 1');
  else if (query.flag === 'new') conds.push('isNew = 1');
  if (query.stock === 'out') {
    conds.push(`EXISTS (SELECT 1 FROM product_variants v WHERE v.productId = products.id AND v.stock <= 0)`);
  } else if (query.stock === 'low') {
    conds.push(`EXISTS (SELECT 1 FROM product_variants v WHERE v.productId = products.id AND v.stock > 0 AND v.stock <= ?)`);
    params.push(threshold);
  } else if (query.stock === 'in') {
    conds.push(`NOT EXISTS (SELECT 1 FROM product_variants v WHERE v.productId = products.id AND v.stock <= ?)`);
    params.push(threshold);
  }
  return { sql: `WHERE ${conds.join(' AND ')}`, params };
}

/** ORDER BY fragments; sort keys are whitelisted by the route, never interpolated raw. */
const PRODUCT_SORT_SQL: Record<string, string> = {
  name: 'nameEn',
  price: 'basePrice',
  stock: '(SELECT COALESCE(SUM(stock), 0) FROM product_variants WHERE productId = products.id)',
  updated: 'updatedAt',
  order: 'displayOrder',
};

/** The ids (in list order) matching a query, without pagination — for export and Delete All. */
export async function listProductIds(query: ProductListQuery): Promise<string[]> {
  const settings = await prisma.storeSettings.findUnique({ where: { id: 'singleton' }, select: { lowStockThreshold: true } });
  const threshold = settings?.lowStockThreshold ?? 5;
  const { sql, params } = buildProductListWhere(query, threshold);
  const sortSql = PRODUCT_SORT_SQL[query.sort] ?? PRODUCT_SORT_SQL.updated;
  const dir = query.dir === 'asc' ? 'ASC' : 'DESC';
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id FROM products ${sql} ORDER BY ${sortSql} ${dir}`,
    ...params,
  );
  return rows.map((r) => r.id);
}

export async function listProducts(query: ProductListQuery) {
  const settings = await prisma.storeSettings.findUnique({ where: { id: 'singleton' }, select: { lowStockThreshold: true } });
  const threshold = settings?.lowStockThreshold ?? 5;
  const { sql, params } = buildProductListWhere(query, threshold);
  const totalRows = await prisma.$queryRawUnsafe<Array<{ total: number }>>(`SELECT COUNT(*) as total FROM products ${sql}`, ...params);
  const total = Number(totalRows[0]?.total ?? 0);
  const pageSize = Math.max(1, query.pageSize);
  const pageCount = pageCountFor(total, pageSize);
  const page = clampPage(query.page, pageCount);
  const sortSql = PRODUCT_SORT_SQL[query.sort] ?? PRODUCT_SORT_SQL.updated;
  const dir = query.dir === 'asc' ? 'ASC' : 'DESC';
  const idRows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id FROM products ${sql} ORDER BY ${sortSql} ${dir} LIMIT ? OFFSET ?`,
    ...params,
    pageSize,
    (page - 1) * pageSize,
  );
  const ids = idRows.map((r) => r.id);
  const rows = ids.length ? await prisma.product.findMany({ where: { id: { in: ids } }, include: PRODUCT_INCLUDE }) : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = ids.map((id) => byId.get(id)!).filter(Boolean);
  return { items: ordered.map(toAdminProduct), total, page, pageSize, pageCount };
}

export async function getProductById(id: string) {
  const row = await prisma.product.findUnique({ where: { id }, include: PRODUCT_INCLUDE });
  if (!row) throw notFound('Product not found.');
  return toAdminProduct(row);
}

/** Cheap existence check, for callers that must answer 404 before they validate a request body. */
export async function assertProductExists(id: string): Promise<void> {
  const existing = await prisma.product.findUnique({ where: { id }, select: { id: true } });
  if (!existing) throw notFound('Product not found.');
}

/**
 * Server-side slug/SKU availability for the editor (H16): the editor's client-side
 * check only ever saw one capped page, so the save-time checks are the authority —
 * this endpoint lets the editor surface the same answer BEFORE the save fails.
 * Returns the clashing product's name per SKU so the editor can point at the field.
 */
export async function checkProductAvailability({ slug, skus, excludeId }: { slug: string; skus: string[]; excludeId: string | null }) {
  const [slugClash, skuClashes] = await Promise.all([
    slug
      ? prisma.product.findUnique({ where: { slug }, select: { id: true, nameEn: true } })
      : Promise.resolve(null),
    skus.length
      ? prisma.productVariant.findMany({
          where: { sku: { in: skus }, ...(excludeId ? { NOT: { productId: excludeId } } : {}) },
          select: { sku: true, product: { select: { nameEn: true } } },
        })
      : Promise.resolve([]),
  ]);
  return {
    slugAvailable: !slugClash || slugClash.id === excludeId,
    slugUsedBy: slugClash && slugClash.id !== excludeId ? slugClash.nameEn : null,
    skuClashes: skuClashes.map((c) => ({ sku: c.sku, usedBy: c.product.nameEn })),
  };
}

export async function createProduct(input: ProductInput) {
  await assertProductReferencesExist(input);
  await assertProductSlugAvailable(input.slug, null);
  await assertProductSkusAvailable(input, null);
  const id = await saveProduct(null, input);
  const row = await prisma.product.findUniqueOrThrow({ where: { id }, include: PRODUCT_INCLUDE });
  return toAdminProduct(row);
}

export async function updateProduct(id: string, input: ProductInput) {
  const existing = await prisma.product.findUnique({ where: { id }, select: { id: true } });
  if (!existing) throw notFound('Product not found.');
  await assertProductReferencesExist(input);
  await assertProductSlugAvailable(input.slug, existing.id);
  await assertProductSkusAvailable(input, existing.id);
  await saveProduct(existing.id, input);
  const row = await prisma.product.findUniqueOrThrow({ where: { id: existing.id }, include: PRODUCT_INCLUDE });
  return toAdminProduct(row);
}

/**
 * Real duplicate (H17): copies the product with all its options, values, variants,
 * images and specs; the copy is a draft with zero stock, a unique “-copy” slug and
 * fresh “-COPY” SKUs, and its flags cleared so it never leaks onto the homepage.
 * New ids are generated (never reused) so the copy edits independently of the source.
 */
export async function duplicateProduct(id: string) {
  const src = await prisma.product.findUnique({ where: { id }, include: PRODUCT_INCLUDE });
  if (!src) throw notFound('Product not found.');

  const slugs = new Set((await prisma.product.findMany({ select: { slug: true } })).map((p) => p.slug));
  let slug = `${src.slug}-copy`;
  for (let n = 2; slugs.has(slug); n++) slug = `${src.slug}-copy-${n}`;
  const skus = new Set((await prisma.productVariant.findMany({ select: { sku: true } })).map((v) => v.sku));
  const uniqueSku = (sku: string) => {
    let candidate = `${sku}-COPY`.slice(0, 40);
    for (let n = 2; skus.has(candidate); n++) candidate = `${sku}-C${n}`.slice(0, 40);
    skus.add(candidate);
    return candidate;
  };

  const input = toAdminProduct(src);
  const copyInput: ProductInput = {
    ...input,
    slug,
    status: 'draft',
    name: { en: `${input.name.en} (copy)`, hi: input.name.hi },
    isFeatured: false,
    isBestseller: false,
    isNew: false,
    options: input.options.map((o) => ({ ...o, id: `copy-${o.id}`, values: o.values.map((v) => ({ ...v, id: `copy-${v.id}` })) })),
    variants: input.variants.map((v) => ({
      ...v,
      id: `copy-${v.id}`,
      sku: uniqueSku(v.sku),
      stock: 0,
      options: Object.fromEntries(Object.entries(v.options).map(([k, val]) => [`copy-${k}`, `copy-${val}`])),
    })),
    specs: input.specs.map((s) => ({ ...s, id: `copy-${s.id}` })),
  };
  const newId = await saveProduct(null, copyInput);
  const row = await prisma.product.findUniqueOrThrow({ where: { id: newId }, include: PRODUCT_INCLUDE });
  return toAdminProduct(row);
}

export async function changeProductStatus(id: string, status: ProductStatus) {
  const current = await prisma.product.findUnique({ where: { id }, include: PRODUCT_INCLUDE });
  if (!current) throw notFound('Product not found.');

  if (status === 'active') {
    // Re-run the full publish rules against what is actually stored.
    const check = productInputSchema.safeParse({ ...toAdminProduct(current), status: 'active' });
    if (!check.success) {
      throw badRequest(
        'This product cannot be published yet.',
        check.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    if (!current.category.isActive) throw conflict('Its category is inactive, so it would stay hidden. Activate the category first.');
  }

  const row = await prisma.product.update({ where: { id: current.id }, data: { status }, include: PRODUCT_INCLUDE });
  return toAdminProduct(row);
}

/**
 * Deletes products in one transaction — either the whole filtered set (H7: the admin
 * passes the same list filters, so "Delete All" only ever deletes what the owner is
 * looking at) or, with no filters, the whole catalogue. Media rows and Cloudinary
 * files are deliberately KEPT: a media file can be shared by several products (and by
 * the store logo), so deleting them here could break other pages; only the
 * productImage join rows go. Inventory adjustments are kept too — they are the audit
 * trail, and their denormalised snapshots survive product deletion by design (like
 * order snapshots). The deletion itself is recorded in the audit log, in the same
 * transaction, with the actor and the filters that selected the set.
 */
export async function deleteAllProducts(actor: string, query?: ProductListQuery) {
  const ids = query ? await listProductIds(query) : null;
  const deleted = await prisma.$transaction(async (tx) => {
    const where = ids ? { productId: { in: ids } } : {};
    const productWhere = ids ? { id: { in: ids } } : {};
    const optionValueWhere = ids ? { option: { productId: { in: ids } } } : {};
    await tx.productImage.deleteMany({ where });
    await tx.productOptionValue.deleteMany({ where: optionValueWhere });
    await tx.productOption.deleteMany({ where: productWhere });
    await tx.productVariant.deleteMany({ where: productWhere });
    await tx.productSpec.deleteMany({ where: productWhere });
    const result = await tx.product.deleteMany({ where: productWhere });
    const deletedCount = result?.count ?? 0;
    await recordAuditLog(tx, {
      actor,
      action: 'products.delete_all',
      targetType: 'products',
      targetId: null,
      detail: ids
        ? `Deleted ${deletedCount} product(s) matching the current list filters. Media files and inventory history were kept.`
        : `Deleted all ${deletedCount} product(s). Media files and inventory history were kept.`,
    });
    return deletedCount;
  });
  return { deleted };
}

/**
 * Writes the product and all of its children in a single transaction: either the whole product saves
 * or nothing does, so a failed variant can never leave a half-updated product behind.
 */
async function saveProduct(existingId: string | null, input: ProductInput): Promise<string> {
  const id = existingId ?? `p-${input.slug}`.slice(0, 60);

  const scalars = {
    slug: input.slug,
    status: input.status,
    nameEn: input.name.en,
    nameHi: input.name.hi,
    shortDescriptionEn: input.shortDescription.en,
    shortDescriptionHi: input.shortDescription.hi,
    descriptionEn: input.description.en,
    descriptionHi: input.description.hi,
    categoryId: input.categoryId,
    itemGroupId: input.itemGroupId ?? null,
    navLinkId: input.navLinkId ?? null,
    collectionId: input.collectionId ?? null,
    barcode: input.barcode?.trim() ? input.barcode.trim() : null,
    costPrice: input.costPrice ?? null,
    tags: stringifyJson(input.tags),
    nameSearch: input.name.en.toLowerCase(),
    // Pre-computed lowercase haystack keeps search case-insensitive on any engine.
    searchText: buildProductSearchText([input.name.en, input.name.hi, input.slug, input.tags.join(' '), input.variants.map((v) => v.sku).join(' ')]),
    basePrice: input.basePrice,
    baseSalePrice: input.baseSalePrice,
    materialsEn: input.materials.en,
    materialsHi: input.materials.hi,
    careEn: input.care.en,
    careHi: input.care.hi,
    returnsAllowed: input.returnsAllowed,
    exchangeAllowed: input.exchangeAllowed,
    returnDays: input.returnDays,
    weightValue: input.weight.value,
    weightUnit: input.weight.unit,
    dimLength: input.dimensions.length,
    dimWidth: input.dimensions.width,
    dimHeight: input.dimensions.height,
    dimUnit: input.dimensions.unit,
    isFeatured: input.isFeatured,
    isBestseller: input.isBestseller,
    isNew: input.isNew,
    displayOrder: input.displayOrder,
    seoTitleEn: input.seo.title.en,
    seoTitleHi: input.seo.title.hi,
    seoDescriptionEn: input.seo.description.en,
    seoDescriptionHi: input.seo.description.hi,
  };

  await prisma.$transaction(async (tx) => {
    // H3: read the CURRENT stock of every existing variant BEFORE the children are replaced.
    // A sale or restock between the editor loading the page and saving must never be
    // overwritten by the stale stock the form sends back — the mock already protects
    // this (admin productService.update); live mode now does too.
    const currentStock = new Map<string, number>();
    if (existingId) {
      const current = await tx.productVariant.findMany({ where: { productId: existingId }, select: { id: true, stock: true } });
      for (const v of current) currentStock.set(v.id, v.stock);
    }

    if (existingId) {
      await tx.product.update({ where: { id: existingId }, data: scalars });
      // Children are fully replaced: simplest correct model for an editor that submits the whole product.
      await tx.productImage.deleteMany({ where: { productId: existingId } });
      await tx.productOption.deleteMany({ where: { productId: existingId } });
      await tx.productVariant.deleteMany({ where: { productId: existingId } });
      await tx.productSpec.deleteMany({ where: { productId: existingId } });
    } else {
      await tx.product.create({ data: { id, ...scalars } });
    }

    if (input.images.length) {
      await tx.productImage.createMany({
        data: input.images.map((img, position) => ({ productId: id, mediaId: img.mediaId, position, altEn: img.alt.en, altHi: img.alt.hi })),
      });
    }

    // Option/value ids are prefixed with the product id to stay globally unique (two products can both
    // have an option called "color"). The editor round-trips a loaded product's ids back on save, so
    // re-prefixing an already-prefixed id would grow a new layer on every save — each id is only
    // prefixed once. A variant's `options` map must store these SAME final ids (not the raw input ones),
    // because the admin UI matches a variant to its option values by looking up `variant.options[option.id]`
    // against the `option.id` this transaction just wrote.
    const optionIdFor = (rawOptionId: string) => (rawOptionId.startsWith(`${id}__`) ? rawOptionId : `${id}__${rawOptionId}`);
    const valueIdFor = (finalOptionId: string, rawValueId: string) => (rawValueId.startsWith(`${finalOptionId}__`) ? rawValueId : `${finalOptionId}__${rawValueId}`);
    const optionIdMap = new Map<string, string>();
    const valueIdMap = new Map<string, string>();

    for (const [position, option] of input.options.entries()) {
      const finalOptionId = optionIdFor(option.id);
      optionIdMap.set(option.id, finalOptionId);
      await tx.productOption.create({
        data: {
          id: finalOptionId,
          productId: id,
          nameEn: option.name.en,
          nameHi: option.name.hi,
          type: option.type,
          position,
          values: {
            create: option.values.map((v, vPos) => {
              const finalValueId = valueIdFor(finalOptionId, v.id);
              valueIdMap.set(`${option.id}|${v.id}`, finalValueId);
              return { id: finalValueId, labelEn: v.label.en, labelHi: v.label.hi, swatch: v.swatch, position: vPos };
            }),
          },
        },
      });
    }
    const remapVariantOptions = (raw: Record<string, string>): Record<string, string> =>
      Object.fromEntries(Object.entries(raw).map(([rawOptId, rawValId]) => [optionIdMap.get(rawOptId) ?? rawOptId, valueIdMap.get(`${rawOptId}|${rawValId}`) ?? rawValId]));

    if (input.variants.length) {
      // Existing variants keep their CURRENT stock (H3); only brand-new variants take
      // the form's initial stock — and that initial stock gets a history row (H2).
      const variantRows = input.variants.map((v, position) => {
        const finalId = v.id.startsWith(id) ? v.id : `${id}--${v.id}`;
        const preservedStock = currentStock.get(finalId);
        return {
          id: finalId,
          productId: id,
          sku: v.sku,
          options: stringifyJson(remapVariantOptions(v.options)),
          price: v.price,
          salePrice: v.salePrice,
          stock: preservedStock ?? v.stock,
          imageIds: stringifyJson(v.imageIds),
          position,
        };
      });
      await tx.productVariant.createMany({ data: variantRows });
      const initialStock = variantRows.filter((r) => !currentStock.has(r.id) && r.stock > 0);
      if (initialStock.length) {
        await tx.inventoryAdjustment.createMany({
          data: initialStock.map((r) => {
            const raw = input.variants.find((v) => (v.id.startsWith(id) ? v.id : `${id}--${v.id}`) === r.id);
            const label = input.options
              .map((o) => o.values.find((val) => val.id === raw?.options[o.id])?.label.en)
              .filter((x): x is string => !!x)
              .join(' / ');
            return adjustmentData({
              productId: id,
              variantId: r.id,
              sku: r.sku,
              productNameEn: input.name.en,
              productNameHi: input.name.hi,
              variantLabel: label,
              before: 0,
              after: r.stock,
              reason: 'restock',
              note: 'Initial stock for a new variant (product editor).',
              actor: 'admin',
            });
          }),
        });
      }
    }

    if (input.specs.length) {
      await tx.productSpec.createMany({
        data: input.specs.map((s, position) => ({
          id: `${id}__spec__${s.id}`,
          productId: id,
          labelEn: s.label.en,
          labelHi: s.label.hi,
          valueEn: s.value.en,
          valueHi: s.value.hi,
          position,
        })),
      });
    }
  }, { maxWait: 10_000, timeout: 30_000 });

  return id;
}
