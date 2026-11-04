/**
 * Attach DIGNITYARTEDGE JSON image URLs to products already imported in the database.
 *
 * Preview only: npm run catalog:images
 * Apply:        npm run catalog:images -- --apply
 * Optional:     DIGNITY_JSON_PATH=C:\path\products.json npm run catalog:images -- --apply
 *
 * The media id is deterministic (listing id + image position), so reruns update the same media rows
 * and never duplicate a product's gallery entry. Existing unrelated product images are preserved.
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const JSON_PATH = process.env.DIGNITY_JSON_PATH ?? 'C:\\Users\\mannu\\Downloads\\DIGNITYARTEDGE_catalog\\DIGNITYARTEDGE_products.json';
const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

type SourceProduct = {
  listing_id: string;
  name: string;
  images?: string[];
};

type SourceFile = { products?: SourceProduct[] };

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

function mediaId(listingId: string, position: number) {
  const safeListing = listingId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 32);
  return `dae_${safeListing}_${position + 1}`;
}

function highResolutionUrl(raw: string) {
  return raw.replace(/\/il_\d+x\d+\./, '/il_1588xN.');
}

async function download(rawUrl: string) {
  const original = new URL(rawUrl);
  if (!original.hostname.toLowerCase().endsWith('etsystatic.com')) throw new Error(`Unsupported image host: ${original.hostname}`);

  const candidates = [...new Set([highResolutionUrl(rawUrl), rawUrl])];
  let lastError = 'download failed';
  for (const url of candidates) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { accept: 'image/jpeg,image/png,image/webp,image/gif' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const mimeType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      if (!ALLOWED_TYPES.has(mimeType)) throw new Error(`unsupported content type ${mimeType || '(missing)'}`);
      const declared = Number(response.headers.get('content-length') ?? 0);
      if (declared > MAX_BYTES) throw new Error('larger than 5 MB');
      const data = Buffer.from(await response.arrayBuffer());
      if (!data.length) throw new Error('empty response');
      if (data.length > MAX_BYTES) throw new Error('larger than 5 MB');
      return { data, mimeType, finalUrl: url };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(lastError);
}

async function main() {
  const source = JSON.parse(await readFile(JSON_PATH, 'utf8')) as SourceFile;
  const products = source.products ?? [];
  const dbProducts = await prisma.product.findMany({ select: { id: true, slug: true, nameEn: true } });
  const bySlug = new Map(dbProducts.map((product) => [product.slug, product]));
  const byName = new Map(dbProducts.map((product) => [product.nameEn.trim().toLowerCase(), product]));

  let matched = 0;
  let missing = 0;
  let attached = 0;
  let failed = 0;
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'}: ${products.length} JSON products, ${dbProducts.length} database products`);

  for (const sourceProduct of products) {
    const product = bySlug.get(slugify(sourceProduct.name)) ?? byName.get(sourceProduct.name.trim().toLowerCase());
    if (!product) {
      missing++;
      console.warn(`MISS product: ${sourceProduct.name}`);
      continue;
    }
    matched++;
    const urls = [...new Set((sourceProduct.images ?? []).filter(Boolean))];
    if (!urls.length) {
      console.warn(`NO IMAGE: ${sourceProduct.name}`);
      continue;
    }

    if (!APPLY) {
      attached += urls.length;
      console.log(`MATCH ${product.slug}: ${urls.length} image(s)`);
      continue;
    }

    const currentCount = await prisma.productImage.count({ where: { productId: product.id } });
    for (const [index, url] of urls.entries()) {
      const id = mediaId(sourceProduct.listing_id || createHash('sha1').update(sourceProduct.name).digest('hex').slice(0, 16), index);
      try {
        const image = await download(url);
        const fileName = basename(new URL(image.finalUrl).pathname).slice(0, 190) || `${id}.jpg`;
        await prisma.$transaction(async (tx) => {
          await tx.media.upsert({
            where: { id },
            create: {
              id, fileName, mimeType: image.mimeType, sizeBytes: image.data.length,
              width: null, height: null, altEn: sourceProduct.name.slice(0, 200), altHi: '',
              data: image.data, source: 'upload',
            },
            update: {
              fileName, mimeType: image.mimeType, sizeBytes: image.data.length,
              altEn: sourceProduct.name.slice(0, 200), data: image.data,
            },
          });
          await tx.productImage.upsert({
            where: { productId_mediaId: { productId: product.id, mediaId: id } },
            create: { productId: product.id, mediaId: id, position: currentCount + index, altEn: sourceProduct.name.slice(0, 200), altHi: '' },
            update: { altEn: sourceProduct.name.slice(0, 200), altHi: '' },
          });
        }, { maxWait: 10_000, timeout: 30_000 });
        attached++;
        console.log(`OK ${product.slug} <- ${id}`);
      } catch (error) {
        failed++;
        console.error(`FAIL ${product.slug}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  console.log(`\nMatched: ${matched} | Missing: ${missing} | ${APPLY ? 'Attached' : 'Would attach'}: ${attached} | Failed: ${failed}`);
  if (!APPLY) console.log('No database changes made. Run again with --apply to import the images.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
