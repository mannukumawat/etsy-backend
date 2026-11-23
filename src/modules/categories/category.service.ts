import { prisma } from '../../shared/database/prisma.js';
import { badRequest, conflict, notFound } from '../../shared/errors/http-error.js';
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

export async function deleteCategory(id: string, reassignTo?: string) {
  const cat = await prisma.category.findUnique({ where: { id } });
  if (!cat) throw notFound('Category not found.');

  const productCount = await prisma.product.count({ where: { categoryId: id } });
  if (productCount > 0) {
    if (!reassignTo) {
      throw conflict(`${productCount} products use this category. Choose another category for them first.`, [
        { path: 'reassignTo', message: 'Reassignment category required.' },
      ]);
    }
    if (reassignTo === id) {
      throw badRequest('Cannot reassign to the category being deleted.', [
        { path: 'reassignTo', message: 'Choose a different category.' },
      ]);
    }
    const target = await prisma.category.findUnique({ where: { id: reassignTo } });
    if (!target) {
      throw badRequest('Reassignment category not found.', [
        { path: 'reassignTo', message: 'Choose an existing category.' },
      ]);
    }
  }

  return prisma.$transaction(async (tx) => {
    if (productCount > 0 && reassignTo) {
      await tx.product.updateMany({
        where: { categoryId: id },
        data: { categoryId: reassignTo },
      });
    }
    await tx.category.delete({ where: { id } });
    return { moved: productCount, ok: true };
  });
}
