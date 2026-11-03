/**
 * Idempotent: fix category slugs/names to match required catalog spec.
 * Run: npx tsx scripts/fix-categories.ts
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const p = new PrismaClient();

// Map: current slug → target spec
const RENAMES: Array<{
  fromSlug: string;
  toSlug: string;
  nameEn: string;
  descriptionEn: string;
  displayOrder: number;
}> = [
  {
    fromSlug: 'kilim-rug',
    toSlug: 'kilim-rugs',
    nameEn: 'Kilim Rugs',
    descriptionEn:
      'Handwoven flatweave Kilim rugs crafted from wool and jute. Geometric diamonds, zigzags and traditional Rajasthani motifs in warm neutral and earthy tones. Reversible and durable for living rooms, entryways and bedrooms.',
    displayOrder: 0,
  },
  {
    fromSlug: 'wool-jute-runner',
    toSlug: 'wool-jute-runners',
    nameEn: 'Wool & Jute Runners',
    descriptionEn:
      'Long narrow runners handwoven from wool and jute. Perfect for hallways, corridors and staircases. Bohemian stripes and Kilim patterns in natural earthy colours.',
    displayOrder: 1,
  },
  {
    fromSlug: 'kilim-bench',
    toSlug: 'kilim-benches',
    nameEn: 'Kilim Benches',
    descriptionEn:
      'Handcrafted wooden benches upholstered in authentic Kilim fabric. Rustic farmhouse style with bold geometric textile patterns. Great as an entryway bench or bedroom accent piece.',
    displayOrder: 2,
  },
  {
    fromSlug: 'cotton-yoga-mat',
    toSlug: 'cotton-yoga-mats',
    nameEn: 'Cotton Yoga Mats',
    descriptionEn:
      'Woven cotton yoga mats made for mindful practice. Natural, non-synthetic materials with traditional stripe and geometric weave patterns. Foldable, lightweight and eco-conscious.',
    displayOrder: 3,
  },
  {
    fromSlug: 'jute-rug',
    toSlug: 'jute-rugs',
    nameEn: 'Jute Rugs',
    descriptionEn:
      'Natural jute rugs woven from sustainably sourced plant fibres. Earthy, textured and durable. Ideal for adding warmth to living rooms, dining spaces and sunrooms.',
    displayOrder: 4,
  },
  {
    fromSlug: 'round-jute-rug',
    toSlug: 'round-jute-rugs',
    nameEn: 'Round Jute Rugs',
    descriptionEn:
      'Circular jute rugs that define a space with a soft organic shape. Natural tones and woven textures for under dining tables, reading corners and centre-of-room accents.',
    displayOrder: 5,
  },
  {
    fromSlug: 'cushion-cover',
    toSlug: 'cushion-covers',
    nameEn: 'Cushion Covers',
    descriptionEn:
      'Handwoven and block-printed cushion covers in Kilim and traditional Indian textile patterns. Cover only; insert not included. Mix and match to refresh any sofa or reading nook.',
    displayOrder: 6,
  },
  {
    fromSlug: 'throw-blanket',
    toSlug: 'throws',
    nameEn: 'Throws',
    descriptionEn:
      'Soft handwoven throws in wool and cotton. Draped over a sofa or bed, they add instant warmth and Bohemian texture. Fringed edges and traditional stripe or check patterns.',
    displayOrder: 7,
  },
  {
    fromSlug: 'scalloped-jute-rug',
    toSlug: 'scalloped-jute-rugs',
    nameEn: 'Scalloped Jute Rugs',
    descriptionEn:
      'Jute rugs with distinctive curved scalloped edges for a decorative silhouette. Natural fibre construction with a playful, artisan border finish.',
    displayOrder: 8,
  },
];

// New category to create
const NEW_CATEGORIES: Array<{
  id: string;
  slug: string;
  nameEn: string;
  descriptionEn: string;
  displayOrder: number;
}> = [
  {
    id: 'cat-jute-doormats',
    slug: 'jute-doormats',
    nameEn: 'Jute Doormats',
    descriptionEn:
      'Handwoven jute doormats for doorstep and entryway. Naturally coarse jute fibres trap dirt and dust. Classic stripe and plain weave patterns in neutral tones to complement any entrance.',
    displayOrder: 9,
  },
];

async function main() {
  let updated = 0;
  let created = 0;
  let skipped = 0;

  // Fix existing categories
  for (const spec of RENAMES) {
    const existing = await p.category.findUnique({ where: { slug: spec.fromSlug } });
    if (!existing) {
      console.log(`SKIP (not found): ${spec.fromSlug}`);
      skipped++;
      continue;
    }
    // Check if target slug already exists as a different row
    const targetExists = await p.category.findFirst({
      where: { slug: spec.toSlug, id: { not: existing.id } },
    });
    if (targetExists) {
      console.log(`SKIP (target slug already exists): ${spec.toSlug}`);
      skipped++;
      continue;
    }
    await p.category.update({
      where: { id: existing.id },
      data: {
        slug: spec.toSlug,
        nameEn: spec.nameEn,
        descriptionEn: spec.descriptionEn,
        displayOrder: spec.displayOrder,
      },
    });
    console.log(`UPDATED: ${spec.fromSlug} → ${spec.toSlug}`);
    updated++;
  }

  // Create missing categories
  for (const spec of NEW_CATEGORIES) {
    const existing = await p.category.findUnique({ where: { slug: spec.slug } });
    if (existing) {
      // Update description if blank
      if (!existing.descriptionEn) {
        await p.category.update({ where: { id: existing.id }, data: { descriptionEn: spec.descriptionEn, displayOrder: spec.displayOrder } });
        console.log(`UPDATED description: ${spec.slug}`);
        updated++;
      } else {
        console.log(`SKIP (already exists): ${spec.slug}`);
        skipped++;
      }
      continue;
    }
    await p.category.create({
      data: {
        id: spec.id,
        slug: spec.slug,
        nameEn: spec.nameEn,
        nameHi: '',
        descriptionEn: spec.descriptionEn,
        descriptionHi: '',
        displayOrder: spec.displayOrder,
        isActive: true,
      },
    });
    console.log(`CREATED: ${spec.slug}`);
    created++;
  }

  console.log(`\nDone. Updated: ${updated}, Created: ${created}, Skipped: ${skipped}`);
  await p.$disconnect();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
