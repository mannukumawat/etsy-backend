import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { v2 as cloudinary } from 'cloudinary';
import { prisma } from '../../shared/database/prisma.js';
import { badRequest, notFound } from '../../shared/errors/http-error.js';
import { env, isCloudinaryConfigured } from '../../shared/config/env.js';
import type { MediaUploadInput, MediaUrlImportInput } from './media.schema.js';

if (isCloudinaryConfigured) {
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

// Images live in the database and are served from a stable URL, so both apps keep working after a
// restart (no blob: URLs, no local file paths, no CDN dependency yet).

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const METADATA_SELECT = { id: true, fileName: true, mimeType: true, sizeBytes: true, width: true, height: true, altEn: true, altHi: true, source: true, createdAt: true, cloudinaryUrl: true, cloudinaryId: true } as const;

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
 * even though its id is not secret. A signed-in owner can always preview any media regardless (see
 * `getMediaBytes`), which is the only case that needs to see not-yet-published art.
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

/** The media row to serve as bytes. 404 when it does not exist, or when the viewer is not the owner and
 *  the image is not referenced by anything currently published (see `isMediaPublic`). */
export async function getMediaBytes(id: string, viewerIsOwner: boolean) {
  const row = await prisma.media.findUnique({ where: { id } });
  if (!row) throw notFound('Image not found.');

  if (!viewerIsOwner) {
    const isPublic = await isMediaPublic(id);
    if (!isPublic) throw notFound('Image not found.');
  }
  return row;
}

/** Returns Cloudinary URL if asset is on Cloudinary, else null (fall back to byte-serving). */
export function getCloudinaryUrl(row: { cloudinaryUrl: string | null }): string | null {
  return row.cloudinaryUrl ?? null;
}

/** Owner only: list metadata (never the bytes). `q` is already trimmed. */
export function listMedia(q: string) {
  return prisma.media.findMany({
    where: q ? { OR: [{ fileName: { contains: q } }, { altEn: { contains: q } }] } : undefined,
    orderBy: { createdAt: 'desc' },
    select: METADATA_SELECT,
    take: 500,
  });
}

export async function uploadMedia(input: MediaUploadInput) {
  const data = Buffer.from(input.base64, 'base64');
  if (!data.length) throw badRequest('The uploaded file is empty.');
  if (data.length > MAX_BYTES) throw badRequest('Images must be 5 MB or smaller.');

  const id = `m_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  let cloudinaryUrl: string | null = null;
  let cloudinaryId: string | null = null;

  if (isCloudinaryConfigured) {
    const dataUri = `data:${input.mimeType};base64,${input.base64}`;
    const result = await cloudinary.uploader.upload(dataUri, {
      public_id: id,
      folder: 'etcy',
      resource_type: 'image',
    });
    cloudinaryUrl = result.secure_url;
    cloudinaryId = result.public_id;
  }

  return prisma.media.create({
    data: {
      id,
      fileName: input.fileName,
      mimeType: input.mimeType,
      sizeBytes: data.length,
      width: input.width,
      height: input.height,
      altEn: input.alt.en,
      altHi: input.alt.hi,
      data: cloudinaryUrl ? null : data,
      cloudinaryUrl,
      cloudinaryId,
      source: 'upload',
    },
    select: METADATA_SELECT,
  });
}

export async function importMediaFromUrl(input: MediaUrlImportInput) {
  const image = await downloadImage(input.url);
  const id = `m_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  let cloudinaryUrl: string | null = null;
  let cloudinaryId: string | null = null;

  if (isCloudinaryConfigured) {
    const result = await cloudinary.uploader.upload(input.url, {
      public_id: id,
      folder: 'etcy',
      resource_type: 'image',
    });
    cloudinaryUrl = result.secure_url;
    cloudinaryId = result.public_id;
  }

  return prisma.media.create({
    data: {
      id,
      fileName: image.fileName,
      mimeType: image.mimeType,
      sizeBytes: image.data.length,
      width: null,
      height: null,
      altEn: input.alt.en,
      altHi: input.alt.hi,
      data: cloudinaryUrl ? null : image.data,
      cloudinaryUrl,
      cloudinaryId,
      source: 'upload',
    },
    select: METADATA_SELECT,
  });
}
