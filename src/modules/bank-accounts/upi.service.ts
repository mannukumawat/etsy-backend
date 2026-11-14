import { prisma } from '../../shared/database/prisma.js';
import { notFound } from '../../shared/errors/http-error.js';
import { randomHexId } from '../../shared/utils/ids.js';
import type { AddUpiInput } from './upi.schema.js';

interface UpiRow {
  id: string;
  customer_id: string;
  upi_id: string;
  holder_name: string;
  is_active: number;
  created_at: Date;
}

export async function ensureUpiTable() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS customer_upi_ids (
      id              VARCHAR(24)  NOT NULL PRIMARY KEY,
      customer_id     VARCHAR(30)  NOT NULL,
      upi_id          VARCHAR(100) NOT NULL,
      holder_name     VARCHAR(80)  NOT NULL,
      is_active       TINYINT(1)   NOT NULL DEFAULT 1,
      created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      INDEX idx_cust (customer_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

export async function listUpiIds(customerId: string) {
  await ensureUpiTable();
  const rows = await prisma.$queryRawUnsafe<UpiRow[]>(
    `SELECT * FROM customer_upi_ids WHERE customer_id = ? AND is_active = 1 ORDER BY created_at DESC`,
    customerId,
  );
  return rows.map((r) => ({ id: r.id, upiId: r.upi_id, holderName: r.holder_name, createdAt: r.created_at.toISOString() }));
}

export async function addUpiId(customerId: string, input: AddUpiInput) {
  await ensureUpiTable();
  const id = randomHexId(12);
  await prisma.$executeRawUnsafe(
    `INSERT INTO customer_upi_ids (id, customer_id, upi_id, holder_name, is_active, created_at) VALUES (?, ?, ?, ?, 1, NOW(3))`,
    id, customerId, input.upiId.trim(), input.holderName.trim(),
  );
  const rows = await prisma.$queryRawUnsafe<UpiRow[]>(`SELECT * FROM customer_upi_ids WHERE id = ?`, id);
  const r = rows[0]!;
  return { id: r.id, upiId: r.upi_id, holderName: r.holder_name, createdAt: r.created_at.toISOString() };
}

export async function removeUpiId(customerId: string, id: string) {
  await ensureUpiTable();
  const rows = await prisma.$queryRawUnsafe<UpiRow[]>(
    `SELECT * FROM customer_upi_ids WHERE id = ? AND customer_id = ? AND is_active = 1`,
    id, customerId,
  );
  if (!rows[0]) throw notFound('UPI ID not found.');
  await prisma.$executeRawUnsafe(`UPDATE customer_upi_ids SET is_active = 0 WHERE id = ?`, id);
}
