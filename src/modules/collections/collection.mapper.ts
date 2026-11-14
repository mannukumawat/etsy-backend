import type { Prisma } from '@prisma/client';
import { mediaUrl } from '../../shared/config/env.js';
import { parseStringArray } from '../../shared/utils/json.js';
import { L, Lopt } from '../../shared/utils/localized.js';
import { toStorefrontProduct } from '../products/product.mapper.js';

type CollectionRow = Prisma.CollectionGetPayload<{ include: { circles: true; sections: true } }>;

export function toAdminCollection(c: CollectionRow) {
  return {
    id: c.id,
    slug: c.slug,
    title: L(c.titleEn, c.titleHi),
    subtitle: L(c.subtitleEn, c.subtitleHi),
    description: L(c.descriptionEn, c.descriptionHi),
    heroImageId: c.heroImageId,
    heroColor: c.heroColor,
    status: c.status as 'draft' | 'published',
    displayOrder: c.displayOrder,
    showInNavigation: c.showInNavigation,
    publishedAt: c.publishedAt ? c.publishedAt.toISOString() : null,
    circles: c.circles
      .sort((a, b) => a.position - b.position)
      .map((ci) => ({ id: ci.id, label: L(ci.labelEn, ci.labelHi), imageId: ci.imageId, linkType: ci.linkType as 'category' | 'collection' | 'url', linkValue: ci.linkValue })),
    sections: c.sections
      .sort((a, b) => a.position - b.position)
      .map((s) => ({ id: s.id, title: L(s.titleEn, s.titleHi), productIds: parseStringArray(s.productIds) })),
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

/** Published-only shape for the storefront, with products resolved per section and circle links
 *  rewritten to real hrefs. `resolveProduct` returns the storefront Product shape (or undefined if a
 *  referenced product is no longer active, in which case it is silently skipped). */
export function toStorefrontCollection(
  c: CollectionRow,
  resolveProduct: (id: string) => ReturnType<typeof toStorefrontProduct> | undefined,
) {
  const circleHref = (ci: CollectionRow['circles'][number]) => {
    if (ci.linkType === 'category') return `/category/${ci.linkValue}`;
    if (ci.linkType === 'collection') return `/collection/${ci.linkValue}`;
    return ci.linkValue;
  };
  return {
    slug: c.slug,
    title: Lopt(c.titleEn, c.titleHi),
    subtitle: Lopt(c.subtitleEn, c.subtitleHi),
    description: Lopt(c.descriptionEn, c.descriptionHi),
    heroImage: c.heroImageId ? mediaUrl(c.heroImageId) : null,
    heroColor: c.heroColor,
    circles: c.circles
      .sort((a, b) => a.position - b.position)
      .map((ci) => ({ label: Lopt(ci.labelEn, ci.labelHi), image: ci.imageId ? mediaUrl(ci.imageId) : null, href: circleHref(ci) })),
    sections: c.sections
      .sort((a, b) => a.position - b.position)
      .map((s) => ({
        title: Lopt(s.titleEn, s.titleHi),
        products: parseStringArray(s.productIds)
          .map(resolveProduct)
          .filter((p): p is ReturnType<typeof toStorefrontProduct> => !!p),
      })),
  };
}
