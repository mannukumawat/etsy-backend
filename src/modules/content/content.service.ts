import { prisma } from '../../shared/database/prisma.js';
import { badRequest, conflict, notFound } from '../../shared/errors/http-error.js';
import { stringifyJson } from '../../shared/utils/json.js';
import { homepageContentSchema, PAGE_KEYS, pageContentSchema, type HomepageContentInput, type PageContentInput, type PageKey } from './content.schema.js';

// Homepage is a singleton draft/published document; the 7 info/policy pages are one row each, keyed
// by a fixed PageKey. Both follow the same draft -> publish -> (optional) discard lifecycle: saving a
// draft only checks that referenced products/categories/images EXIST; publishing additionally
// requires them to be active, matching admin/src/services/contentServices.ts exactly.

const LEGAL_PAGES = new Set<string>(['returns', 'privacy', 'terms']);
// Used only the very first time nothing has ever been saved (prisma/seed.ts normally seeds real copy
// before the admin ever loads this page). Non-blank placeholders because hero/story/newsletter titles
// are required fields, same as the mock's own draft-time rules.
const EMPTY_HOMEPAGE: HomepageContentInput = homepageContentSchema.parse({
  announcement: { enabled: false, text: { en: '', hi: '' } },
  hero: { title: { en: 'Your Store' }, subtitle: { en: '' }, imageId: null, ctaLabel: { en: 'Shop now' }, ctaHref: '/shop' },
  slides: [],
  featuredCategoryIds: [],
  featuredProductIds: [],
  bestsellerProductIds: [],
  newArrivalProductIds: [],
  itemsProductIds: [],
  transferProductIds: [],
  story: { title: { en: 'Our story' }, body: { en: '' }, imageId: null, ctaLabel: { en: '' }, ctaHref: '' },
  newsletter: { title: { en: 'Newsletter' }, body: { en: '' } },
});

export function assertPageKey(key: string): asserts key is PageKey {
  if (!(PAGE_KEYS as readonly string[]).includes(key)) throw notFound('No such page.');
}

// --- reference checks -------------------------------------------------------------------------------

async function assertMedia(id: string, path: string) {
  const media = await prisma.media.findUnique({ where: { id }, select: { id: true } });
  if (!media) throw badRequest('Selected image no longer exists.', [{ path, message: 'Image not found.' }]);
}

async function assertHomepageReferencesExist(c: HomepageContentInput, publishing: boolean) {
  if (c.hero.imageId) await assertMedia(c.hero.imageId, 'hero.imageId');
  if (c.story.imageId) await assertMedia(c.story.imageId, 'story.imageId');
  for (const [i, sl] of c.slides.entries()) if (sl.imageId) await assertMedia(sl.imageId, `slides.${i}.imageId`);

  const productIds = [...new Set([...c.featuredProductIds, ...c.bestsellerProductIds, ...c.newArrivalProductIds, ...c.itemsProductIds, ...c.transferProductIds])];
  if (productIds.length) {
    const found = await prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, nameEn: true, status: true } });
    for (const id of productIds) {
      const p = found.find((x) => x.id === id);
      if (!p) throw badRequest('A selected product no longer exists.', [{ path: 'featuredProductIds', message: 'Product not found.' }]);
      if (publishing && p.status !== 'active') {
        throw conflict(`"${p.nameEn}" is not active, so it cannot be published on the homepage.`, [{ path: 'featuredProductIds', message: 'Product is not active.' }]);
      }
    }
  }
  if (c.featuredCategoryIds.length) {
    const found = await prisma.category.findMany({ where: { id: { in: c.featuredCategoryIds } }, select: { id: true, nameEn: true, isActive: true } });
    for (const id of c.featuredCategoryIds) {
      const cat = found.find((x) => x.id === id);
      if (!cat) throw badRequest('A selected category no longer exists.', [{ path: 'featuredCategoryIds', message: 'Category not found.' }]);
      if (publishing && !cat.isActive) {
        throw conflict(`Category "${cat.nameEn}" is inactive.`, [{ path: 'featuredCategoryIds', message: 'Category is inactive.' }]);
      }
    }
  }
}

async function assertPageMedia(c: PageContentInput) {
  if (c.heroImageId) await assertMedia(c.heroImageId, 'heroImageId');
  for (const [i, s] of c.sections.entries()) if (s.imageId) await assertMedia(s.imageId, `sections.${i}.imageId`);
}

// --- homepage ---------------------------------------------------------------------------------------

export function getHomepageDraft() {
  return prisma.homepageContent.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', draftJson: stringifyJson(EMPTY_HOMEPAGE) },
    update: {},
  });
}

export async function saveHomepageDraft(input: HomepageContentInput, updatedBy: string) {
  await assertHomepageReferencesExist(input, false);
  return prisma.homepageContent.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', draftJson: stringifyJson(input), updatedBy },
    update: { draftJson: stringifyJson(input), updatedBy },
  });
}

export async function publishHomepage(updatedBy: string) {
  const row = await prisma.homepageContent.findUnique({ where: { id: 'singleton' } });
  if (!row) throw notFound('No draft to publish.');
  const draft = homepageContentSchema.parse(JSON.parse(row.draftJson));
  await assertHomepageReferencesExist(draft, true);
  return prisma.homepageContent.update({
    where: { id: 'singleton' },
    data: { publishedJson: row.draftJson, publishedAt: new Date(), updatedBy },
  });
}

export async function discardHomepageDraft(updatedBy: string) {
  const row = await prisma.homepageContent.findUnique({ where: { id: 'singleton' } });
  if (!row?.publishedJson) throw conflict('Nothing has been published yet.');
  return prisma.homepageContent.update({
    where: { id: 'singleton' },
    data: { draftJson: row.publishedJson, updatedBy },
  });
}

// --- pages ------------------------------------------------------------------------------------------

/** Returns the page row, creating an empty draft the first time a page is requested. */
export async function getPage(key: PageKey) {
  return prisma.pageDoc.upsert({
    where: { key },
    create: { key, isLegal: LEGAL_PAGES.has(key), draftJson: stringifyJson({ title: { en: '' }, intro: { en: '' }, heroImageId: null, sections: [] }) },
    update: {},
  });
}

export function listPages() {
  return Promise.all(PAGE_KEYS.map((key) => getPage(key)));
}

export async function savePageDraft(key: PageKey, input: PageContentInput, updatedBy: string) {
  await assertPageMedia(input);
  return prisma.pageDoc.upsert({
    where: { key },
    create: { key, isLegal: LEGAL_PAGES.has(key), draftJson: stringifyJson(input), updatedBy },
    update: { draftJson: stringifyJson(input), updatedBy },
  });
}

export async function publishPage(key: PageKey, updatedBy: string) {
  const row = await prisma.pageDoc.findUnique({ where: { key } });
  if (!row) throw notFound('No draft to publish.');
  await assertPageMedia(pageContentSchema.parse(JSON.parse(row.draftJson)));
  return prisma.pageDoc.update({
    where: { key },
    data: { publishedJson: row.draftJson, publishedAt: new Date(), updatedBy },
  });
}

export async function discardPageDraft(key: PageKey, updatedBy: string) {
  const row = await prisma.pageDoc.findUnique({ where: { key } });
  if (!row?.publishedJson) throw conflict('Nothing has been published yet.');
  return prisma.pageDoc.update({ where: { key }, data: { draftJson: row.publishedJson, updatedBy } });
}
