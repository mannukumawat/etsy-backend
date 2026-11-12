import { Router } from 'express';
import { requireOwner } from '../auth.js';
import { prisma } from '../db.js';
import { badRequest, conflict, notFound, route } from '../http.js';
import { stringifyJson } from '../json.js';
import { toAdminHomepage, toAdminPageDoc, toStorefrontHomepage, toStorefrontPageContent } from '../mappers.js';
import { homepageContentSchema, PAGE_KEYS, pageContentSchema, type HomepageContentInput, type PageContentInput, type PageKey } from '../validation.js';

// Homepage is a singleton draft/published document; the 7 info/policy pages are one row each, keyed
// by a fixed PageKey. Both follow the same draft -> publish -> (optional) discard lifecycle: saving a
// draft only checks that referenced products/categories/images EXIST; publishing additionally
// requires them to be active, matching admin/src/services/contentServices.ts exactly.

export const contentRouter = Router();
export const publicContentRouter = Router();

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

async function assertMedia(id: string, path: string) {
  const media = await prisma.media.findUnique({ where: { id }, select: { id: true } });
  if (!media) throw badRequest('Selected image no longer exists.', [{ path, message: 'Image not found.' }]);
}

contentRouter.use(requireOwner);

// --- homepage -------------------------------------------------------------------------------------

contentRouter.get(
  '/homepage',
  route(async (_req, res) => {
    const row = await prisma.homepageContent.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', draftJson: stringifyJson(EMPTY_HOMEPAGE) },
      update: {},
    });
    res.json(toAdminHomepage(row));
  }),
);

contentRouter.put(
  '/homepage',
  route(async (req, res) => {
    const input = homepageContentSchema.parse(req.body);
    await assertHomepageReferencesExist(input, false);
    const row = await prisma.homepageContent.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', draftJson: stringifyJson(input), updatedBy: req.owner!.email },
      update: { draftJson: stringifyJson(input), updatedBy: req.owner!.email },
    });
    res.json(toAdminHomepage(row));
  }),
);

contentRouter.post(
  '/homepage/publish',
  route(async (req, res) => {
    const row = await prisma.homepageContent.findUnique({ where: { id: 'singleton' } });
    if (!row) throw notFound('No draft to publish.');
    const draft = homepageContentSchema.parse(JSON.parse(row.draftJson));
    await assertHomepageReferencesExist(draft, true);
    const updated = await prisma.homepageContent.update({
      where: { id: 'singleton' },
      data: { publishedJson: row.draftJson, publishedAt: new Date(), updatedBy: req.owner!.email },
    });
    res.json(toAdminHomepage(updated));
  }),
);

contentRouter.post(
  '/homepage/discard',
  route(async (req, res) => {
    const row = await prisma.homepageContent.findUnique({ where: { id: 'singleton' } });
    if (!row?.publishedJson) throw conflict('Nothing has been published yet.');
    const updated = await prisma.homepageContent.update({
      where: { id: 'singleton' },
      data: { draftJson: row.publishedJson, updatedBy: req.owner!.email },
    });
    res.json(toAdminHomepage(updated));
  }),
);

// --- pages ----------------------------------------------------------------------------------------

function assertPageKey(key: string): asserts key is PageKey {
  if (!(PAGE_KEYS as readonly string[]).includes(key)) throw notFound('No such page.');
}

contentRouter.get(
  '/pages',
  route(async (_req, res) => {
    const rows = await Promise.all(PAGE_KEYS.map((key) => ensurePage(key)));
    res.json({ items: rows.map(toAdminPageDoc) });
  }),
);

contentRouter.get(
  '/pages/:key',
  route(async (req, res) => {
    assertPageKey(req.params.key);
    res.json(toAdminPageDoc(await ensurePage(req.params.key)));
  }),
);

contentRouter.put(
  '/pages/:key',
  route(async (req, res) => {
    assertPageKey(req.params.key);
    const input: PageContentInput = pageContentSchema.parse(req.body);
    await assertPageMedia(input);
    const row = await prisma.pageDoc.upsert({
      where: { key: req.params.key },
      create: { key: req.params.key, isLegal: LEGAL_PAGES.has(req.params.key), draftJson: stringifyJson(input), updatedBy: req.owner!.email },
      update: { draftJson: stringifyJson(input), updatedBy: req.owner!.email },
    });
    res.json(toAdminPageDoc(row));
  }),
);

contentRouter.post(
  '/pages/:key/publish',
  route(async (req, res) => {
    assertPageKey(req.params.key);
    const row = await prisma.pageDoc.findUnique({ where: { key: req.params.key } });
    if (!row) throw notFound('No draft to publish.');
    await assertPageMedia(pageContentSchema.parse(JSON.parse(row.draftJson)));
    const updated = await prisma.pageDoc.update({
      where: { key: req.params.key },
      data: { publishedJson: row.draftJson, publishedAt: new Date(), updatedBy: req.owner!.email },
    });
    res.json(toAdminPageDoc(updated));
  }),
);

contentRouter.post(
  '/pages/:key/discard',
  route(async (req, res) => {
    assertPageKey(req.params.key);
    const row = await prisma.pageDoc.findUnique({ where: { key: req.params.key } });
    if (!row?.publishedJson) throw conflict('Nothing has been published yet.');
    const updated = await prisma.pageDoc.update({ where: { key: req.params.key }, data: { draftJson: row.publishedJson, updatedBy: req.owner!.email } });
    res.json(toAdminPageDoc(updated));
  }),
);

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

async function ensurePage(key: PageKey) {
  return prisma.pageDoc.upsert({
    where: { key },
    create: { key, isLegal: LEGAL_PAGES.has(key), draftJson: stringifyJson({ title: { en: '' }, intro: { en: '' }, heroImageId: null, sections: [] }) },
    update: {},
  });
}

// --- public (storefront) -------------------------------------------------------------------------
// Published content only. A singleton/page with nothing published yet returns `published: false` and
// a null content — a real empty state, never a silent fallback to old sample copy.

publicContentRouter.get(
  '/homepage',
  route(async (_req, res) => {
    const row = await prisma.homepageContent.findUnique({ where: { id: 'singleton' } });
    if (!row?.publishedJson) return res.json({ published: false, content: null });
    res.json({ published: true, content: toStorefrontHomepage(JSON.parse(row.publishedJson)) });
  }),
);

publicContentRouter.get(
  '/pages/:key',
  route(async (req, res) => {
    assertPageKey(req.params.key);
    const row = await prisma.pageDoc.findUnique({ where: { key: req.params.key } });
    if (!row?.publishedJson) return res.json({ published: false, content: null });
    res.json({ published: true, content: toStorefrontPageContent(JSON.parse(row.publishedJson)) });
  }),
);
