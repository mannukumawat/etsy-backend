import { mediaUrl } from '../../shared/config/env.js';
import { prisma } from '../../shared/database/prisma.js';
import { badRequest, conflict, notFound } from '../../shared/errors/http-error.js';
import { stringifyJson } from '../../shared/utils/json.js';
import { PRODUCT_INCLUDE, toStorefrontProduct } from '../products/product.mapper.js';
import { ratingSummaries } from '../reviews/review-stats.service.js';
import { toStorefrontCollection } from './collection.mapper.js';
import type { CollectionInput } from './collection.schema.js';

// Curated landing pages (Wedding Guide-style) and curated listing pages (Top Gifts-style, which are
// just a Collection with no hero/circles and one section) — distinct from Category: a product can
// appear in many collections, unlike its single catalogue category.

const COLLECTION_INCLUDE = { circles: true, sections: true } as const;
const VISIBLE_PRODUCT = { status: 'active', category: { isActive: true } } as const;

async function assertReferencesExist(input: { circles: Array<{ imageId: string | null; linkType: string; linkValue: string }>; sections: Array<{ productIds: string[] }> }) {
  const imageIds = [...new Set(input.circles.map((c) => c.imageId).filter((id): id is string => !!id))];
  if (imageIds.length) {
    const found = await prisma.media.findMany({ where: { id: { in: imageIds } }, select: { id: true } });
    const missing = imageIds.filter((id) => !found.some((f) => f.id === id));
    if (missing.length) throw badRequest(`Unknown image reference: ${missing.join(', ')}.`, [{ path: 'circles', message: 'Image not found.' }]);
  }
  const categorySlugs = input.circles.filter((c) => c.linkType === 'category').map((c) => c.linkValue);
  if (categorySlugs.length) {
    const found = await prisma.category.findMany({ where: { slug: { in: categorySlugs } }, select: { slug: true } });
    const missing = categorySlugs.filter((s) => !found.some((f) => f.slug === s));
    if (missing.length) throw badRequest(`Unknown category: ${missing.join(', ')}.`, [{ path: 'circles', message: 'Category not found.' }]);
  }
  const collectionSlugs = input.circles.filter((c) => c.linkType === 'collection').map((c) => c.linkValue);
  if (collectionSlugs.length) {
    const found = await prisma.collection.findMany({ where: { slug: { in: collectionSlugs } }, select: { slug: true } });
    const missing = collectionSlugs.filter((s) => !found.some((f) => f.slug === s));
    if (missing.length) throw badRequest(`Unknown collection: ${missing.join(', ')}.`, [{ path: 'circles', message: 'Collection not found.' }]);
  }
  const productIds = [...new Set(input.sections.flatMap((s) => s.productIds))];
  if (productIds.length) {
    const found = await prisma.product.count({ where: { id: { in: productIds } } });
    if (found !== productIds.length) throw badRequest('A selected product no longer exists.', [{ path: 'sections', message: 'Product not found.' }]);
  }
}

async function assertSlugFree(slug: string, selfId: string | null) {
  const clash = await prisma.collection.findUnique({ where: { slug } });
  if (clash && clash.id !== selfId) throw conflict('Another collection already uses this slug.', [{ path: 'slug', message: 'Already in use.' }]);
}

async function writeCollection(existingId: string | null, input: CollectionInput) {
  const id = existingId ?? `col-${input.slug}`.slice(0, 60);
  const scalars = {
    slug: input.slug,
    titleEn: input.titleEn,
    titleHi: input.titleHi,
    subtitleEn: input.subtitleEn,
    subtitleHi: input.subtitleHi,
    descriptionEn: input.descriptionEn,
    descriptionHi: input.descriptionHi,
    heroImageId: input.heroImageId,
    heroColor: input.heroColor,
    displayOrder: input.displayOrder,
    showInNavigation: input.showInNavigation,
  };
  await prisma.$transaction(async (tx) => {
    if (existingId) {
      await tx.collection.update({ where: { id: existingId }, data: scalars });
      await tx.collectionCircle.deleteMany({ where: { collectionId: existingId } });
      await tx.collectionSection.deleteMany({ where: { collectionId: existingId } });
    } else {
      await tx.collection.create({ data: { id, ...scalars } });
    }
    if (input.circles.length) {
      await tx.collectionCircle.createMany({
        data: input.circles.map((c, position) => ({ collectionId: id, labelEn: c.labelEn, labelHi: c.labelHi, imageId: c.imageId, linkType: c.linkType, linkValue: c.linkValue, position })),
      });
    }
    await tx.collectionSection.createMany({
      data: input.sections.map((s, position) => ({ collectionId: id, titleEn: s.titleEn, titleHi: s.titleHi, position, productIds: stringifyJson(s.productIds) })),
    });
  });
  return id;
}

// --- admin ------------------------------------------------------------------------------------------

export function listCollections() {
  return prisma.collection.findMany({ include: COLLECTION_INCLUDE, orderBy: { displayOrder: 'asc' } });
}

export async function getCollection(id: string) {
  const row = await prisma.collection.findUnique({ where: { id }, include: COLLECTION_INCLUDE });
  if (!row) throw notFound('Collection not found.');
  return row;
}

export async function getCollectionOrThrow(id: string) {
  const existing = await prisma.collection.findUnique({ where: { id } });
  if (!existing) throw notFound('Collection not found.');
  return existing;
}

export async function createCollection(input: CollectionInput) {
  await assertSlugFree(input.slug, null);
  await assertReferencesExist(input);
  const id = await writeCollection(null, input);
  return prisma.collection.findUniqueOrThrow({ where: { id }, include: COLLECTION_INCLUDE });
}

export async function updateCollection(existingId: string, input: CollectionInput) {
  await assertSlugFree(input.slug, existingId);
  await assertReferencesExist(input);
  await writeCollection(existingId, input);
  return prisma.collection.findUniqueOrThrow({ where: { id: existingId }, include: COLLECTION_INCLUDE });
}

export async function changeCollectionStatus(id: string, status: 'draft' | 'published') {
  const existing = await prisma.collection.findUnique({ where: { id }, include: COLLECTION_INCLUDE });
  if (!existing) throw notFound('Collection not found.');
  if (status === 'published' && !existing.sections.some((s) => s.productIds !== '[]')) {
    throw badRequest('Add at least one product before publishing.', [{ path: 'sections', message: 'No products selected.' }]);
  }
  return prisma.collection.update({
    where: { id: existing.id },
    data: { status, publishedAt: status === 'published' ? new Date() : existing.publishedAt },
    include: COLLECTION_INCLUDE,
  });
}

export async function deleteCollection(id: string) {
  const existing = await getCollectionOrThrow(id);
  await prisma.collection.delete({ where: { id: existing.id } });
}

// --- public (storefront) ----------------------------------------------------------------------------

/** Published collections for the storefront's Categories menu: title + one cover photo each (its hero
 *  image, else its first visible product's main image). */
export async function listPublishedCollections() {
  const rows = await prisma.collection.findMany({
    where: { status: 'published' },
    include: { sections: { orderBy: { position: 'asc' } } },
    orderBy: [{ displayOrder: 'asc' }, { titleEn: 'asc' }],
  });
  return Promise.all(
    rows.map(async (c) => {
      let image = c.heroImageId ? mediaUrl(c.heroImageId) : null;
      if (!image) {
        const ids = c.sections.flatMap((s) => JSON.parse(s.productIds || '[]') as string[]);
        const products = ids.length ? await prisma.product.findMany({ where: { id: { in: ids }, ...VISIBLE_PRODUCT }, include: { images: { orderBy: { position: 'asc' }, take: 1 } } }) : [];
        const first = ids.map((id) => products.find((p) => p.id === id)).find((p) => p?.images[0]);
        if (first) image = mediaUrl(first.images[0].mediaId);
      }
      return { slug: c.slug, title: { en: c.titleEn }, image, showInNavigation: c.showInNavigation };
    }),
  );
}

export async function getPublishedCollection(slug: string) {
  const row = await prisma.collection.findFirst({ where: { slug, status: 'published' }, include: COLLECTION_INCLUDE });
  if (!row) throw notFound('Collection not found.');

  const productIds = [...new Set(row.sections.flatMap((s) => JSON.parse(s.productIds || '[]') as string[]))];
  const products = productIds.length
    ? await prisma.product.findMany({ where: { id: { in: productIds }, ...VISIBLE_PRODUCT }, include: PRODUCT_INCLUDE })
    : [];
  const ratings = await ratingSummaries(products.map((p) => p.id));
  const byId = new Map(products.map((p) => [p.id, toStorefrontProduct(p, ratings.get(p.id))]));

  const body = toStorefrontCollection(row, (id) => byId.get(id));
  // A circle without its own photo borrows one from what it links to (the category's image, or the
  // linked collection's hero / first product), so the row never shows empty circles.
  // (toStorefrontCollection sorted row.circles in place, so indexes line up.)
  body.circles = await Promise.all(
    body.circles.map(async (circle, i) => {
      if (circle.image) return circle;
      const src = row.circles[i];
      if (src.linkType === 'category') {
        const cat = await prisma.category.findFirst({ where: { slug: src.linkValue }, select: { imageId: true } });
        return { ...circle, image: cat?.imageId ? mediaUrl(cat.imageId) : null };
      }
      if (src.linkType === 'collection') {
        const target = await prisma.collection.findFirst({ where: { slug: src.linkValue }, include: { sections: { orderBy: { position: 'asc' } } } });
        if (target?.heroImageId) return { ...circle, image: mediaUrl(target.heroImageId) };
        const firstId = target ? target.sections.flatMap((s) => JSON.parse(s.productIds || '[]') as string[])[0] : undefined;
        const img = firstId ? await prisma.productImage.findFirst({ where: { productId: firstId }, orderBy: { position: 'asc' }, select: { mediaId: true } }) : null;
        return { ...circle, image: img ? mediaUrl(img.mediaId) : null };
      }
      return circle;
    }),
  );
  return body;
}
