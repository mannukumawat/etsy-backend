import { prisma } from '../../shared/database/prisma.js';
import { notFound } from '../../shared/errors/http-error.js';
import type { ItemGroupInput } from './item-group.schema.js';

const itemGroupData = (input: ItemGroupInput) => ({
  nameEn: input.nameEn,
  nameHi: input.nameHi,
  slug: input.slug,
  position: input.position,
  isActive: input.isActive,
  imageId: input.imageId ?? null,
});

export async function getItemGroupOrThrow(id: string) {
  const existing = await prisma.itemGroup.findUnique({ where: { id } });
  if (!existing) throw notFound('Item group not found.');
  return existing;
}

export function createItemGroup(input: ItemGroupInput) {
  return prisma.itemGroup.create({ data: itemGroupData(input) });
}

export function updateItemGroup(id: string, input: ItemGroupInput) {
  return prisma.itemGroup.update({ where: { id }, data: itemGroupData(input) });
}

export async function deleteItemGroup(id: string) {
  const existing = await getItemGroupOrThrow(id);
  await prisma.itemGroup.delete({ where: { id: existing.id } });
}

/** Bulk reorder: `ids` in the new display order. Returns the groups in their new order. */
export async function reorderItemGroups(ids: string[]) {
  await prisma.$transaction(ids.map((id, position) => prisma.itemGroup.update({ where: { id }, data: { position } })));
  return prisma.itemGroup.findMany({ orderBy: { position: 'asc' } });
}
