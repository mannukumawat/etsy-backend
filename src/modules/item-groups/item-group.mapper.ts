interface ItemGroupRow {
  id: string;
  nameEn: string;
  nameHi: string;
  slug: string;
  position: number;
  isActive: boolean;
  imageId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function toItemGroup(g: ItemGroupRow) {
  return {
    id: g.id,
    nameEn: g.nameEn,
    nameHi: g.nameHi,
    slug: g.slug,
    position: g.position,
    isActive: g.isActive,
    imageId: g.imageId,
    createdAt: g.createdAt.toISOString(),
    updatedAt: g.updatedAt.toISOString(),
  };
}

export function toAdminItemGroup(g: ItemGroupRow & { _count: { products: number } }) {
  return { ...toItemGroup(g), productCount: g._count.products };
}
