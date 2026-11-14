import { prisma } from '../../shared/database/prisma.js';
import { assertMediaExists } from '../media/media-reference.service.js';
import { toAdminCategory } from './category.mapper.js';
import type { CategoryInput } from './category.schema.js';

export async function createCategory(input: CategoryInput) {
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
  return toAdminCategory(row, 0);
}

export async function updateCategory(id: string, input: CategoryInput) {
  await assertMediaExists([input.imageId, input.bannerId]);
  const row = await prisma.category.update({
    where: { id },
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
  return toAdminCategory(row, row._count.products);
}
