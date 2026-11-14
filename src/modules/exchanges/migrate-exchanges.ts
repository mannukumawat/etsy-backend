/**
 * One-shot migration: adds exchange support columns/tables and customer bank accounts.
 * Run: npx tsx src/modules/exchanges/migrate-exchanges.ts
 */
import { prisma } from '../../shared/database/prisma.js';

async function run() {
  console.log('Running exchanges / bank-accounts migration...');

  // 1. order_lines: add exchanged_qty
  const lineColumns: Array<[string, string]> = [
    ['exchanged_qty', 'INT NOT NULL DEFAULT 0'],
  ];
  const existing = await prisma.$queryRawUnsafe<{ c: string }[]>(
    `SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_lines'`,
  );
  const have = new Set(existing.map((r) => r.c));
  for (const [name, def] of lineColumns) {
    if (have.has(name)) { console.log('SKIP (already exists): order_lines.' + name); continue; }
    await prisma.$executeRawUnsafe(`ALTER TABLE order_lines ADD COLUMN ${name} ${def}`);
    console.log('OK: order_lines.' + name);
  }

  // 2. return_requests: add refund_account_id, refund_method columns
  const rrColumns: Array<[string, string]> = [
    ['refund_account_id', 'VARCHAR(191) NULL'],
    ['refund_method_override', 'VARCHAR(50) NULL'],
  ];
  const rrExisting = await prisma.$queryRawUnsafe<{ c: string }[]>(
    `SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'return_requests'`,
  );
  const rrHave = new Set(rrExisting.map((r) => r.c));
  for (const [name, def] of rrColumns) {
    if (rrHave.has(name)) { console.log('SKIP (already exists): return_requests.' + name); continue; }
    await prisma.$executeRawUnsafe(`ALTER TABLE return_requests ADD COLUMN ${name} ${def}`);
    console.log('OK: return_requests.' + name);
  }

  // 3. exchange_requests
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS exchange_requests (
      id VARCHAR(191) NOT NULL PRIMARY KEY,
      reference VARCHAR(191) NOT NULL,
      order_id VARCHAR(191) NOT NULL,
      order_line_id VARCHAR(191) NOT NULL,
      original_variant_id VARCHAR(191) NOT NULL,
      replacement_variant_id VARCHAR(191) NOT NULL,
      requested_qty INT NOT NULL,
      approved_qty INT NULL,
      reason VARCHAR(191) NOT NULL,
      customer_note TEXT NULL,
      admin_note TEXT NULL,
      rejection_reason TEXT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'requested',
      price_difference INT NOT NULL DEFAULT 0,
      exchange_window_days INT NOT NULL DEFAULT 7,
      replacement_carrier VARCHAR(191) NULL,
      replacement_tracking VARCHAR(191) NULL,
      requested_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      decided_at DATETIME(3) NULL,
      shipped_at DATETIME(3) NULL,
      delivered_at DATETIME(3) NULL,
      closed_at DATETIME(3) NULL,
      UNIQUE KEY uq_exchange_reference (reference),
      INDEX idx_exchange_order (order_id),
      INDEX idx_exchange_line (order_line_id),
      INDEX idx_exchange_status (status)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci ENGINE=InnoDB
  `);
  console.log('OK: exchange_requests table');

  // 4. exchange_events
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS exchange_events (
      id VARCHAR(191) NOT NULL PRIMARY KEY,
      exchange_id VARCHAR(191) NOT NULL,
      type VARCHAR(100) NOT NULL,
      actor VARCHAR(50) NOT NULL,
      actor_id VARCHAR(191) NULL,
      message TEXT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      INDEX idx_eev_exchange (exchange_id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci ENGINE=InnoDB
  `);
  console.log('OK: exchange_events table');

  // 5. customer_bank_accounts
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS customer_bank_accounts (
      id VARCHAR(191) NOT NULL PRIMARY KEY,
      customer_id VARCHAR(191) NOT NULL,
      account_holder_name VARCHAR(255) NOT NULL,
      account_number_encrypted TEXT NOT NULL,
      account_number_last4 CHAR(4) NOT NULL,
      ifsc_code VARCHAR(11) NOT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      INDEX idx_bac_customer (customer_id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci ENGINE=InnoDB
  `);
  console.log('OK: customer_bank_accounts table');

  const tables = await prisma.$queryRawUnsafe<{ TABLE_NAME: string }[]>(
    `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('exchange_requests','exchange_events','customer_bank_accounts')`,
  );
  console.log('Verified tables:', tables.map((t) => t.TABLE_NAME));

  await prisma.$disconnect();
  console.log('Migration complete.');
}

run().catch((e) => { console.error(e); process.exit(1); });
