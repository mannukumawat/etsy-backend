import { prisma } from '../../shared/database/prisma.js';
import { badRequest, conflict } from '../../shared/errors/http-error.js';
import type { ProductInput } from './product.types.js';
import { assertMediaExists } from '../media/media-reference.service.js';

export async function assertProductReferencesExist(input: ProductInput) {
  const category = await prisma.category.findUnique({ where: { id: input.categoryId }, select: { id: true, isActive: true } });
  if (!category) throw badRequest('Choose an existing category.', [{ path: 'categoryId', message: 'Category not found.' }]);
  if (input.status === 'active' && !category.isActive) {
    throw conflict('Its category is inactive, so the product would stay hidden. Activate the category first.', [
      { path: 'categoryId', message: 'Category is inactive.' },
    ]);
  }
  await assertMediaExists(input.images.map((i) => i.mediaId));
  if (input.collectionId?.trim()) {
    const collection = await prisma.collection.findUnique({ where: { id: input.collectionId.trim() }, select: { id: true } });
    if (!collection) throw badRequest('Choose an existing collection.', [{ path: 'collectionId', message: 'Collection not found.' }]);
  }
  if (input.itemGroupId?.trim()) {
    const group = await prisma.itemGroup.findUnique({ where: { id: input.itemGroupId.trim() }, select: { id: true } });
    if (!group) throw badRequest('Choose an existing item group.', [{ path: 'itemGroupId', message: 'Item group not found.' }]);
  }
  if (input.navLinkId?.trim()) {
    const link = await prisma.navLink.findUnique({ where: { id: input.navLinkId.trim() }, select: { id: true } });
    if (!link) throw badRequest('Choose an existing nav link.', [{ path: 'navLinkId', message: 'Nav link not found.' }]);
  }
}

/** Slugs are unique catalogue-wide; the editor's client-side check only ever saw a
 *  capped page, so the server is the authority (H16) — same friendly conflict shape
 *  as the SKU check, with the field path so the editor can highlight the slug field. */
export async function assertProductSlugAvailable(slug: string, selfId: string | null) {
  const clash = await prisma.product.findUnique({ where: { slug }, select: { id: true, nameEn: true } });
  if (clash && clash.id !== selfId) {
    throw conflict(`Another product already uses the URL “/${slug}”.`, [
      { path: 'slug', message: `“${clash.nameEn}” already uses this URL.` },
    ]);
  }
}

/** SKUs are unique across the whole catalog, not just within a product. */
export async function assertProductSkusAvailable(input: ProductInput, selfId: string | null) {
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
