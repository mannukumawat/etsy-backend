/**
 * One-shot migration: adds return/cancellation support columns and tables.
 * Run: npx tsx src/modules/returns/migrate-returns.ts
 */
import { prisma } from '../../shared/database/prisma.js';

async function run() {
  console.log('Running returns migration...');

  // Add columns to order_lines. MySQL has no `ADD COLUMN IF NOT EXISTS` (only MariaDB does), so check first.
  const lineColumns: Array<[string, string]> = [
    ['cancelled_qty', 'INT NOT NULL DEFAULT 0'],
    ['returned_qty', 'INT NOT NULL DEFAULT 0'],
    ['delivered_at', 'DATETIME NULL'],
    ['return_window_days', 'INT NULL'],
    ['return_shipping_fee', 'INT NOT NULL DEFAULT 0'],
  ];
  const existing = await prisma.$queryRawUnsafe<{ c: string }[]>(
    `SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_lines'`,
  );
  const have = new Set(existing.map((r) => r.c));
  for (const [name, def] of lineColumns) {
    if (have.has(name)) {
      console.log('SKIP (already exists): order_lines.' + name);
      continue;
    }
    await prisma.$executeRawUnsafe(`ALTER TABLE order_lines ADD COLUMN ${name} ${def}`);
    console.log('OK: order_lines.' + name);
  }

  // return_requests
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS return_requests (
      id VARCHAR(191) NOT NULL PRIMARY KEY,
      reference VARCHAR(191) NOT NULL,
      order_id VARCHAR(191) NOT NULL,
      order_line_id VARCHAR(191) NOT NULL,
      variant_id VARCHAR(191) NOT NULL,
      requested_qty INT NOT NULL,
      approved_qty INT NULL,
      received_qty INT NULL,
      accepted_qty INT NULL,
      restock_qty INT NULL,
      reason VARCHAR(191) NOT NULL,
      customer_note TEXT NULL,
      admin_note TEXT NULL,
      rejection_reason TEXT NULL,
      photos TEXT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'requested',
      shipping_method VARCHAR(50) NULL,
      customer_carrier VARCHAR(191) NULL,
      customer_tracking VARCHAR(191) NULL,
      pickup_address TEXT NULL,
      return_carrier VARCHAR(191) NULL,
      return_tracking VARCHAR(191) NULL,
      refundable_amount INT NOT NULL DEFAULT 0,
      shipping_fee INT NOT NULL DEFAULT 0,
      refund_amount INT NULL,
      return_window_days INT NOT NULL DEFAULT 7,
      requested_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      decided_at DATETIME(3) NULL,
      received_at DATETIME(3) NULL,
      inspected_at DATETIME(3) NULL,
      refunded_at DATETIME(3) NULL,
      UNIQUE KEY uq_return_reference (reference),
      INDEX idx_return_order (order_id),
      INDEX idx_return_status (status)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci ENGINE=InnoDB
  `);
  console.log('OK: return_requests table');

  // return_events
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS return_events (
      id VARCHAR(191) NOT NULL PRIMARY KEY,
      return_id VARCHAR(191) NOT NULL,
      type VARCHAR(100) NOT NULL,
      actor VARCHAR(50) NOT NULL,
      actor_id VARCHAR(191) NULL,
      message TEXT NULL,
      data TEXT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      INDEX idx_rev_return (return_id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci ENGINE=InnoDB
  `);
  console.log('OK: return_events table');

  // refunds
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS refunds (
      id VARCHAR(191) NOT NULL PRIMARY KEY,
      order_id VARCHAR(191) NOT NULL,
      return_id VARCHAR(191) NULL,
      amount INT NOT NULL,
      reason TEXT NOT NULL,
      method VARCHAR(50) NOT NULL DEFAULT 'original',
      status VARCHAR(50) NOT NULL DEFAULT 'pending',
      reference VARCHAR(191) NULL,
      completed_at DATETIME(3) NULL,
      failed_at DATETIME(3) NULL,
      recorded_by VARCHAR(191) NULL,
      note TEXT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      INDEX idx_refund_order (order_id),
      UNIQUE KEY uq_refund_return (return_id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci ENGINE=InnoDB
  `);
  console.log('OK: refunds table');

  // Verify
  const tables = await prisma.$queryRawUnsafe<{ TABLE_NAME: string }[]>(
    `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('return_requests','return_events','refunds')`
  );
  console.log('Verified tables:', tables.map(t => t.TABLE_NAME));

  await prisma.$disconnect();
  console.log('Migration complete.');
}

run().catch((e) => { console.error(e); process.exit(1); });
