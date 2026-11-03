import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  console.log('Deleting product children...');
  await prisma.productVariant.deleteMany({});
  await prisma.productOptionValue.deleteMany({});
  await prisma.productOption.deleteMany({});
  await prisma.productSpec.deleteMany({});
  await prisma.productImage.deleteMany({});
  await prisma.wishlistItem.deleteMany({});

  console.log('Deleting products...');
  await prisma.product.deleteMany({});

  console.log('Deleting categories...');
  await prisma.category.deleteMany({});

  console.log('Deleting inventory adjustments...');
  await prisma.inventoryAdjustment.deleteMany({});

  console.log('Deleting media...');
  await prisma.media.deleteMany({});

  console.log('Done. All catalog data cleared.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
