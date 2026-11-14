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
