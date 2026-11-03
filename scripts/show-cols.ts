import { prisma } from '../src/db.js';
for (const t of ['product_options', 'product_option_values', 'product_variants']) {
  const r = await prisma.$queryRawUnsafe(`SHOW COLUMNS FROM \`${t}\``);
  const cols = (r as any[]).map((c: any) => c.Field);
  console.log(`${t}: ${JSON.stringify(cols)}`);
}
await prisma.$disconnect();
