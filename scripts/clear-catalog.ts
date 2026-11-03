import { prisma } from '../src/db.js';

async function run() {
  await prisma.inventoryAdjustment.deleteMany();
  await prisma.productSpec.deleteMany();
  await prisma.productOptionValue.deleteMany();
  await prisma.productVariant.deleteMany();
  await prisma.productOption.deleteMany();
  await prisma.productImage.deleteMany();
  const prod = await prisma.product.deleteMany();
  const cat = await prisma.category.deleteMany();
  const med = await prisma.media.deleteMany();
  console.log(`Done. products: ${prod.count}, categories: ${cat.count}, media: ${med.count}`);
  await prisma.$disconnect();
}

run().catch((e) => { console.error(e.message); process.exit(1); });
