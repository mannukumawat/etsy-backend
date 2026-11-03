/**
 * One-shot migration: adds ui_translation_bundles table for admin UI string overrides.
 * Run: npx tsx src/migrate-ui-i18n.ts
 */
import { prisma } from './db.js';

async function run() {
  console.log('Running UI i18n migration...');

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS ui_translation_bundles (
      lang      VARCHAR(8)   NOT NULL PRIMARY KEY,
      data      LONGTEXT     NOT NULL,
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
    )
  `);
  console.log('OK: ui_translation_bundles table ready');

  await prisma.$disconnect();
  console.log('Done.');
}

run().catch((e) => { console.error(e); process.exit(1); });
