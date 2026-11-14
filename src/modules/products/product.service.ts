import { prisma } from '../../shared/database/prisma.js';
import { badRequest, conflict, notFound } from '../../shared/errors/http-error.js';
import { buildSearchText, stringifyJson } from '../../shared/utils/json.js';
import { PRODUCT_INCLUDE, toAdminProduct } from './product.mapper.js';
import type { ProductInput, ProductListQuery, ProductStatus } from './product.types.js';
import { productInputSchema } from './product.schema.js';
import { assertProductReferencesExist, assertProductSkusAvailable } from './product-reference.service.js';

export async function listProducts(query: ProductListQuery) {
  const { q, status, itemGroup } = query;
  const rows = await prisma.product.findMany({
    where: {
      ...(status === 'draft' || status === 'active' || status === 'archived' ? { status } : {}),
      ...(q ? { searchText: { contains: q.toLowerCase() } } : {}),
      ...(itemGroup ? { itemGroup: { slug: itemGroup } } : {}),
    },
    include: PRODUCT_INCLUDE,
    orderBy: { updatedAt: 'desc' },
    take: 500,
  });
  return { items: rows.map(toAdminProduct), total: rows.length };
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

export async function createProduct(input: ProductInput) {
  await assertProductReferencesExist(input);
  await assertProductSkusAvailable(input, null);
  const id = await saveProduct(null, input);
  const row = await prisma.product.findUniqueOrThrow({ where: { id }, include: PRODUCT_INCLUDE });
  return toAdminProduct(row);
}

export async function updateProduct(id: string, input: ProductInput) {
  const existing = await prisma.product.findUnique({ where: { id }, select: { id: true } });
  if (!existing) throw notFound('Product not found.');
  await assertProductReferencesExist(input);
  await assertProductSkusAvailable(input, existing.id);
  await saveProduct(existing.id, input);
  const row = await prisma.product.findUniqueOrThrow({ where: { id: existing.id }, include: PRODUCT_INCLUDE });
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

export async function deleteAllProducts() {
  await prisma.$transaction(async (tx) => {
    await tx.productImage.deleteMany();
    await tx.productOptionValue.deleteMany();
    await tx.productOption.deleteMany();
    await tx.productVariant.deleteMany();
    await tx.productSpec.deleteMany();
    await tx.product.deleteMany();
  });
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
    tags: stringifyJson(input.tags),
    nameSearch: input.name.en.toLowerCase(),
    // Pre-computed lowercase haystack keeps search case-insensitive on any engine.
    searchText: buildSearchText([input.name.en, input.name.hi, input.slug, input.tags.join(' '), input.variants.map((v) => v.sku).join(' ')]),
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
      await tx.productVariant.createMany({
        data: input.variants.map((v, position) => ({
          id: v.id.startsWith(id) ? v.id : `${id}--${v.id}`,
          productId: id,
          sku: v.sku,
          options: stringifyJson(remapVariantOptions(v.options)),
          price: v.price,
          salePrice: v.salePrice,
          stock: v.stock,
          imageIds: stringifyJson(v.imageIds),
          position,
        })),
      });
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
