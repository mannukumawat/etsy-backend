import { Router } from 'express';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { requireOwner } from '../auth.js';
import { prisma } from '../db.js';
import { badRequest, notFound, route } from '../http.js';
import { mediaUrl } from '../env.js';
import { mediaUploadSchema, mediaUrlImportSchema } from '../validation.js';

// Images live in the database and are served from a stable URL, so both apps keep working after a
// restart (no blob: URLs, no local file paths, no CDN dependency yet).

export const mediaRouter = Router();

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const value = address.toLowerCase().split('%')[0];
  return value === '::1' || value === '::' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb') || value.startsWith('::ffff:127.') || value.startsWith('::ffff:10.') || value.startsWith('::ffff:192.168.');
}

async function assertPublicImageUrl(url: URL) {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw badRequest('Use a public http:// or https:// image URL.');
  const addresses = await lookup(url.hostname, { all: true }).catch(() => []);
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) throw badRequest('The image URL must point to a public host.');
}

async function downloadImage(rawUrl: string): Promise<{ data: Buffer; mimeType: string; fileName: string }> {
  let url = new URL(rawUrl);
  for (let redirects = 0; redirects <= 3; redirects++) {
    await assertPublicImageUrl(url);
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000), headers: { accept: 'image/jpeg,image/png,image/webp,image/gif' } }).catch(() => null);
    if (!response) throw badRequest('Could not download the image from that URL.');
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location || redirects === 3) throw badRequest('The image URL has too many redirects.');
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) throw badRequest(`The image URL returned HTTP ${response.status}.`);
    const mimeType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!ALLOWED_IMAGE_TYPES.has(mimeType)) throw badRequest('The URL must return a JPEG, PNG, WebP or GIF image.');
    const declaredSize = Number(response.headers.get('content-length') ?? 0);
    if (declaredSize > MAX_BYTES) throw badRequest('Images must be 5 MB or smaller.');
    const data = Buffer.from(await response.arrayBuffer());
    if (!data.length) throw badRequest('The image URL returned an empty file.');
    if (data.length > MAX_BYTES) throw badRequest('Images must be 5 MB or smaller.');
    const fileName = decodeURIComponent(url.pathname.split('/').pop() || 'remote-image').slice(0, 180);
    return { data, mimeType, fileName };
  }
  throw badRequest('Could not download the image.');
}

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

adminMediaRouter.post(
  '/from-url',
  route(async (req, res) => {
    const input = mediaUrlImportSchema.parse(req.body);
    const image = await downloadImage(input.url);
    const row = await prisma.media.create({
      data: {
        id: `m_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        fileName: image.fileName,
        mimeType: image.mimeType,
        sizeBytes: image.data.length,
        width: null,
        height: null,
        altEn: input.alt.en,
        altHi: input.alt.hi,
        data: image.data,
        source: 'upload',
      },
    });
    res.status(201).json({
      id: row.id, url: mediaUrl(row.id), fileName: row.fileName, mimeType: row.mimeType,
      sizeBytes: row.sizeBytes, width: row.width, height: row.height,
      alt: { en: row.altEn, hi: row.altHi }, source: row.source, createdAt: row.createdAt.toISOString(),
    });
  }),
);
