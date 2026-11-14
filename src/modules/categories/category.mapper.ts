import type { Prisma } from '@prisma/client';
import { mediaUrl } from '../../shared/config/env.js';
import { L, Lopt } from '../../shared/utils/localized.js';

export type CategoryRow = Prisma.CategoryGetPayload<object>;

export function toAdminCategory(c: CategoryRow, productCount?: number) {
  return {
    id: c.id,
    slug: c.slug,
    name: L(c.nameEn, c.nameHi),
    description: L(c.descriptionEn, c.descriptionHi),
    imageId: c.imageId,
    bannerId: c.bannerId,
    displayOrder: c.displayOrder,
    isActive: c.isActive,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    ...(productCount === undefined ? {} : { productCount }),
  };
}

export function toStorefrontCategory(c: CategoryRow) {
  return {
    id: c.slug,
    slug: c.slug,
    name: Lopt(c.nameEn, c.nameHi),
    description: Lopt(c.descriptionEn, c.descriptionHi),
    image: { src: c.imageId ? mediaUrl(c.imageId) : '', alt: Lopt(c.nameEn, c.nameHi) },
    banner: c.bannerId ? mediaUrl(c.bannerId) : '',
  };
}
