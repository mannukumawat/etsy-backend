import { prisma } from '../../shared/database/prisma.js';
import { notFound } from '../../shared/errors/http-error.js';
import type { NavLinkInput } from './nav.schema.js';

// Admin-managed secondary navigation row (e.g. Gifts, Top Gifts, Wedding Guide), shown site-wide on
// the storefront. Unrelated to the product catalogue's Category model.

const navLinkData = (input: NavLinkInput) => ({
  labelEn: input.labelEn,
  labelHi: input.labelHi,
  href: input.href,
  isActive: input.isActive,
  position: input.position,
});

export async function getNavLinkOrThrow(id: string) {
  const existing = await prisma.navLink.findUnique({ where: { id } });
  if (!existing) throw notFound('Navigation link not found.');
  return existing;
}

export function createNavLink(input: NavLinkInput) {
  return prisma.navLink.create({ data: navLinkData(input) });
}

export function updateNavLink(id: string, input: NavLinkInput) {
  return prisma.navLink.update({ where: { id }, data: navLinkData(input) });
}

export async function deleteNavLink(id: string) {
  const existing = await getNavLinkOrThrow(id);
  await prisma.navLink.delete({ where: { id: existing.id } });
}

/** Bulk reorder: `ids` in the new display order. Returns the links in their new order. */
export async function reorderNavLinks(ids: string[]) {
  await prisma.$transaction(ids.map((id, position) => prisma.navLink.update({ where: { id }, data: { position } })));
  return prisma.navLink.findMany({ orderBy: { position: 'asc' } });
}
