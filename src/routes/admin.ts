import { Router } from 'express';
import { clearSession, issueSession, requireOwner, verifyOwnerCredentials } from '../auth.js';
import { CSRF_COOKIE, issueCsrfCookie } from '../csrf.js';
import { env } from '../env.js';
import { prisma } from '../db.js';
import { badRequest, conflict, notFound, route, unauthorized } from '../http.js';
import { buildSearchText, stringifyJson } from '../json.js';
import { PRODUCT_INCLUDE, toAdminCategory, toAdminProduct } from '../mappers.js';
import { loginAccountLimiter, loginIpLimiter } from '../rateLimit.js';
import { categoryInputSchema, loginSchema, productInputSchema, statusSchema, type ProductInput } from '../validation.js';

// Owner-only catalog management. Every route below `requireOwner` rejects unauthenticated callers,
// and a product plus its options, values, variants, images and specs are written in one transaction.

export const adminRouter = Router();

// --- session ------------------------------------------------------------------------------------

adminRouter.post(
  '/auth/login',
  loginIpLimiter,
  loginAccountLimiter,
  route(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
    const owner = await verifyOwnerCredentials(email, password);
    if (!owner) throw unauthorized('Email or password is incorrect.');
    const csrfToken = issueSession(res, owner);
    res.json({ owner: { id: owner.id, email: owner.email, name: owner.name, role: 'owner' }, csrfToken });
  }),
);

adminRouter.post('/auth/logout', (_req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

adminRouter.get('/auth/me', requireOwner, (req, res) => {
  const existingToken = (req.cookies as Record<string, string> | undefined)?.[CSRF_COOKIE];
  const csrfToken = existingToken || issueCsrfCookie(res, env.SESSION_TTL_HOURS * 60 * 60 * 1000);
  res.json({ owner: { id: req.owner!.sub, email: req.owner!.email, name: req.owner!.name, role: 'owner' }, csrfToken });
});

// Everything past this point requires a valid owner session.
adminRouter.use(requireOwner);

// --- categories ---------------------------------------------------------------------------------

adminRouter.get(
  '/categories',
  route(async (_req, res) => {
    const rows = await prisma.category.findMany({
      orderBy: [{ displayOrder: 'asc' }, { nameEn: 'asc' }],
      include: { _count: { select: { products: true } } },
    });
    res.json({ items: rows.map((c) => toAdminCategory(c, c._count.products)) });
  }),
);

adminRouter.post(
  '/categories',
  route(async (req, res) => {
    const input = categoryInputSchema.parse(req.body);
    await assertMediaExists([input.imageId, input.bannerId]);
    const row = await prisma.category.create({
      data: {
        id: input.slug,
        slug: input.slug,
        nameEn: input.name.en,
        nameHi: input.name.hi,
        descriptionEn: input.description.en,
        descriptionHi: input.description.hi,
        imageId: input.imageId,
        bannerId: input.bannerId,
        displayOrder: input.displayOrder,
        isActive: input.isActive,
      },
    });
    res.status(201).json(toAdminCategory(row, 0));
  }),
);

adminRouter.put(
  '/categories/:id',
  route(async (req, res) => {
    const input = categoryInputSchema.parse(req.body);
    await assertMediaExists([input.imageId, input.bannerId]);
    const row = await prisma.category.update({
      where: { id: req.params.id },
      data: {
        slug: input.slug,
        nameEn: input.name.en,
        nameHi: input.name.hi,
        descriptionEn: input.description.en,
        descriptionHi: input.description.hi,
        imageId: input.imageId,
        bannerId: input.bannerId,
        displayOrder: input.displayOrder,
        isActive: input.isActive,
      },
      include: { _count: { select: { products: true } } },
    });
    res.json(toAdminCategory(row, row._count.products));
  }),
);

// --- products -----------------------------------------------------------------------------------

adminRouter.get(
  '/products',
  route(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const status = String(req.query.status ?? '').trim();
    const itemGroup = String(req.query.itemGroup ?? '').trim();
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
    res.json({ items: rows.map(toAdminProduct), total: rows.length });
  }),
);

adminRouter.get(
  '/products/:id',
  route(async (req, res) => {
    const row = await prisma.product.findUnique({ where: { id: req.params.id }, include: PRODUCT_INCLUDE });
    if (!row) throw notFound('Product not found.');
    res.json(toAdminProduct(row));
  }),
);

adminRouter.post(
  '/products',
  route(async (req, res) => {
    const input = productInputSchema.parse(req.body);
    await assertReferencesExist(input);
    await assertSkusFree(input, null);
    const id = await createOrReplaceProduct(null, input);
    const row = await prisma.product.findUniqueOrThrow({ where: { id }, include: PRODUCT_INCLUDE });
    res.status(201).json(toAdminProduct(row));
  }),
);

adminRouter.put(
  '/products/:id',
  route(async (req, res) => {
    const existing = await prisma.product.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!existing) throw notFound('Product not found.');
    const input = productInputSchema.parse(req.body);
    await assertReferencesExist(input);
    await assertSkusFree(input, existing.id);
    await createOrReplaceProduct(existing.id, input);
    const row = await prisma.product.findUniqueOrThrow({ where: { id: existing.id }, include: PRODUCT_INCLUDE });
    res.json(toAdminProduct(row));
  }),
);

/** Status-only change (publish / unpublish / archive) without resubmitting the whole product. */
adminRouter.patch(
  '/products/:id/status',
  route(async (req, res) => {
    const { status } = statusSchema.parse(req.body);
    const current = await prisma.product.findUnique({ where: { id: req.params.id }, include: PRODUCT_INCLUDE });
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
    res.json(toAdminProduct(row));
  }),
);

/** Delete every product and its children (options, values, variants, images, specs) in one shot. */
adminRouter.delete(
  '/products/all',
  route(async (_req, res) => {
    await prisma.$transaction(async (tx) => {
      await tx.productImage.deleteMany();
      await tx.productOptionValue.deleteMany();
      await tx.productOption.deleteMany();
      await tx.productVariant.deleteMany();
      await tx.productSpec.deleteMany();
      await tx.product.deleteMany();
    });
    res.json({ ok: true });
  }),
);

// --- helpers ------------------------------------------------------------------------------------

async function assertMediaExists(ids: Array<string | null>) {
  const wanted = [...new Set(ids.filter((i): i is string => !!i))];
  if (!wanted.length) return;
  const found = await prisma.media.findMany({ where: { id: { in: wanted } }, select: { id: true } });
  const missing = wanted.filter((id) => !found.some((f) => f.id === id));
  if (missing.length) throw badRequest(`Unknown image reference: ${missing.join(', ')}.`, [{ path: 'images', message: 'Image no longer exists.' }]);
}

async function assertReferencesExist(input: ProductInput) {
  const category = await prisma.category.findUnique({ where: { id: input.categoryId }, select: { id: true, isActive: true } });
  if (!category) throw badRequest('Choose an existing category.', [{ path: 'categoryId', message: 'Category not found.' }]);
  if (input.status === 'active' && !category.isActive) {
    throw conflict('Its category is inactive, so the product would stay hidden. Activate the category first.', [
      { path: 'categoryId', message: 'Category is inactive.' },
    ]);
  }
  await assertMediaExists(input.images.map((i) => i.mediaId));
}

/** SKUs are unique across the whole catalog, not just within a product. */
async function assertSkusFree(input: ProductInput, selfId: string | null) {
  const skus = input.variants.map((v) => v.sku);
  const clashes = await prisma.productVariant.findMany({
    where: { sku: { in: skus }, ...(selfId ? { NOT: { productId: selfId } } : {}) },
    select: { sku: true, product: { select: { nameEn: true } } },
  });
  if (clashes.length) {
    throw conflict(
      `SKU already used by "${clashes[0].product.nameEn}".`,
      clashes.map((c) => ({ path: `variants.${skus.indexOf(c.sku)}.sku`, message: `SKU already used by "${c.product.nameEn}".` })),
    );
  }
}

/**
 * Writes the product and all of its children in a single transaction: either the whole product saves
 * or nothing does, so a failed variant can never leave a half-updated product behind.
 */
async function createOrReplaceProduct(existingId: string | null, input: ProductInput): Promise<string> {
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
