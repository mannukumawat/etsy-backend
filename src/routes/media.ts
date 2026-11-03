import { Router } from 'express';
import { requireOwner } from '../auth.js';
import { prisma } from '../db.js';
import { badRequest, notFound, route } from '../http.js';
import { mediaUrl } from '../env.js';
import { mediaUploadSchema } from '../validation.js';

// Images live in the database and are served from a stable URL, so both apps keep working after a
// restart (no blob: URLs, no local file paths, no CDN dependency yet).

export const mediaRouter = Router();

const MAX_BYTES = 5 * 1024 * 1024;

/**
 * A media row has no explicit "private" flag — publication policy is derived from whether it is
 * actually referenced by something the public can currently see: an active product's gallery or
 * variant images, an active category's image/banner, the store logo, a published collection's hero or
 * circle images, or the published homepage's hero/story image. Anything else — a draft product's
 * photos, a rejected upload, an image removed from a since-edited page — is not publicly reachable,
 * even though its id is not secret. A signed-in owner can always preview any media regardless (see the
 * route below), which is the only case that needs to see not-yet-published art.
 */
async function isMediaPublic(id: string): Promise<boolean> {
  const [productImage, categoryImage, logo, collectionHero, collectionCircle, homepage] = await Promise.all([
    prisma.productImage.findFirst({ where: { mediaId: id, product: { status: 'active', category: { isActive: true } } }, select: { id: true } }),
    prisma.category.findFirst({ where: { isActive: true, OR: [{ imageId: id }, { bannerId: id }] }, select: { id: true } }),
    prisma.storeSettings.findFirst({ where: { id: 'singleton', logoId: id }, select: { id: true } }),
    prisma.collection.findFirst({ where: { status: 'published', heroImageId: id }, select: { id: true } }),
    prisma.collectionCircle.findFirst({ where: { imageId: id, collection: { status: 'published' } }, select: { id: true } }),
    prisma.homepageContent.findUnique({ where: { id: 'singleton' }, select: { publishedJson: true } }),
  ]);
  if (productImage || categoryImage || logo || collectionHero || collectionCircle) return true;
  if (homepage?.publishedJson?.includes(`"${id}"`)) return true;

  // A variant's own image set (ProductVariant.imageIds, a JSON array) is checked separately: the
  // column is JSON-as-text, not a relation, so it can't be joined like the above.
  const variantImage = await prisma.productVariant.findFirst({
    where: { imageIds: { contains: id }, product: { status: 'active', category: { isActive: true } } },
    select: { id: true },
  });
  if (variantImage) return true;

  // Review photos — ids start with "rp_" and are uploaded by customers for their reviews.
  if (id.startsWith('rp_')) {
    const reviewPhoto = await (prisma as any).review.findFirst({ where: { photos: { contains: id }, status: 'published' }, select: { id: true } });
    if (reviewPhoto) return true;
  }
  return false;
}

/** The actual bytes. Public when the image is referenced by something currently published (see
 *  `isMediaPublic`); otherwise owner-only, so a signed-in owner can still preview draft work. Either
 *  way the id is immutable — content changes get a new id — so a genuinely public image can be cached
 *  hard; an owner-only preview must not be, so a shared cache/CDN in front of this API can never serve
 *  it back to the next, unauthenticated requester. */
mediaRouter.get(
  '/:id',
  route(async (req, res) => {
    const row = await prisma.media.findUnique({ where: { id: req.params.id } });
    if (!row) throw notFound('Image not found.');

    if (!req.owner) {
      const isPublic = await isMediaPublic(req.params.id);
      if (!isPublic) throw notFound('Image not found.');
    }

    res.setHeader('Content-Type', row.mimeType);
    // An uploaded SVG opened directly (not via <img>) is a document on this API's origin, where a script
    // inside it could read the readable CSRF cookie and make credentialed calls. Scripts never run inside
    // <img>, so this changes nothing for normal rendering; it only neuters the direct-open case.
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox");
    res.setHeader('Cache-Control', req.owner ? 'private, no-store' : 'public, max-age=31536000, immutable');
    res.setHeader('Content-Length', String(row.data.length));
    res.send(Buffer.from(row.data));
  }),
);

export const adminMediaRouter = Router();
// Every route below requires the owner — including GET, which exposes the full upload inventory
// (filenames, alt text, upload history) for images that may not be public yet.
adminMediaRouter.use(requireOwner);

/** Owner only: list metadata (never the bytes). */
adminMediaRouter.get(
  '/',
  route(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const rows = await prisma.media.findMany({
      where: q ? { OR: [{ fileName: { contains: q } }, { altEn: { contains: q } }] } : undefined,
      orderBy: { createdAt: 'desc' },
      select: { id: true, fileName: true, mimeType: true, sizeBytes: true, width: true, height: true, altEn: true, altHi: true, source: true, createdAt: true },
      take: 500,
    });
    res.json({
      items: rows.map((m) => ({
        id: m.id,
        url: mediaUrl(m.id),
        fileName: m.fileName,
        mimeType: m.mimeType,
        sizeBytes: m.sizeBytes,
        width: m.width,
        height: m.height,
        alt: { en: m.altEn, hi: m.altHi },
        source: m.source,
        createdAt: m.createdAt.toISOString(),
      })),
    });
  }),
);

adminMediaRouter.post(
  '/',
  route(async (req, res) => {
    const input = mediaUploadSchema.parse(req.body);
    const data = Buffer.from(input.base64, 'base64');
    if (!data.length) throw badRequest('The uploaded file is empty.');
    if (data.length > MAX_BYTES) throw badRequest('Images must be 5 MB or smaller.');

    const row = await prisma.media.create({
      data: {
        id: `m_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        fileName: input.fileName,
        mimeType: input.mimeType,
        sizeBytes: data.length,
        width: input.width,
        height: input.height,
        altEn: input.alt.en,
        altHi: input.alt.hi,
        data,
        source: 'upload',
      },
      select: { id: true, fileName: true, mimeType: true, sizeBytes: true, width: true, height: true, altEn: true, altHi: true, source: true, createdAt: true },
    });

    res.status(201).json({
      id: row.id,
      url: mediaUrl(row.id),
      fileName: row.fileName,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      width: row.width,
      height: row.height,
      alt: { en: row.altEn, hi: row.altHi },
      source: row.source,
      createdAt: row.createdAt.toISOString(),
    });
  }),
);
