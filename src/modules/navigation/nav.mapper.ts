import { L, Lopt } from '../../shared/utils/localized.js';

export function toAdminNavLink(n: { id: string; labelEn: string; labelHi: string; href: string; position: number; isActive: boolean; _count?: { products: number } }) {
  return { id: n.id, label: L(n.labelEn, n.labelHi), href: n.href, position: n.position, isActive: n.isActive, productCount: n._count?.products ?? 0 };
}

export function toPublicNavLink(n: { id: string; labelEn: string; labelHi: string; href: string }) {
  return { id: n.id, label: Lopt(n.labelEn, n.labelHi), href: n.href };
}
