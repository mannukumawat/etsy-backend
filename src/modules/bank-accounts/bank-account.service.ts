import { prisma } from '../../shared/database/prisma.js';
import { badRequest, notFound } from '../../shared/errors/http-error.js';
import { randomHexId } from '../../shared/utils/ids.js';
import { encryptAccountNumber } from './bank-account.crypto.js';
import type { BankAccountRow } from './bank-account.mapper.js';
import type { AddBankAccountInput } from './bank-account.schema.js';

async function ensureBankAccountsTable() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS customer_bank_accounts (
      id                       VARCHAR(24)   NOT NULL PRIMARY KEY,
      customer_id              VARCHAR(30)   NOT NULL,
      account_holder_name      VARCHAR(120)  NOT NULL,
      account_number_encrypted TEXT          NOT NULL,
      account_number_last4     VARCHAR(4)    NOT NULL,
      ifsc_code                VARCHAR(11)   NOT NULL,
      is_active                TINYINT(1)    NOT NULL DEFAULT 1,
      created_at               DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      INDEX idx_cust (customer_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

export async function listBankAccounts(customerId: string) {
  await ensureBankAccountsTable();
  return prisma.$queryRawUnsafe<BankAccountRow[]>(
    `SELECT * FROM customer_bank_accounts WHERE customer_id = ? AND is_active = 1 ORDER BY created_at DESC`,
    customerId,
  );
}

export async function addBankAccount(customerId: string, input: AddBankAccountInput) {
  await ensureBankAccountsTable();
  if (input.accountNumber !== input.accountNumberConfirm) {
    throw badRequest('Account numbers do not match.');
  }

  const last4 = input.accountNumber.slice(-4);
  const encrypted = encryptAccountNumber(input.accountNumber);
  const id = randomHexId(12);

  await prisma.$executeRawUnsafe(
    `INSERT INTO customer_bank_accounts
       (id, customer_id, account_holder_name, account_number_encrypted, account_number_last4, ifsc_code, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, NOW(3))`,
    id, customerId, input.accountHolderName.trim(), encrypted, last4, input.ifscCode.toUpperCase(),
  );

  const rows = await prisma.$queryRawUnsafe<BankAccountRow[]>(
    `SELECT * FROM customer_bank_accounts WHERE id = ?`, id,
  );
  return rows[0]!;
}

export async function removeBankAccount(customerId: string, id: string) {
  await ensureBankAccountsTable();
  const rows = await prisma.$queryRawUnsafe<BankAccountRow[]>(
    `SELECT * FROM customer_bank_accounts WHERE id = ? AND customer_id = ? AND is_active = 1`,
    id, customerId,
  );
  if (!rows[0]) throw notFound('Bank account not found.');

  // Soft-delete so existing linked return refunds are unaffected.
  await prisma.$executeRawUnsafe(
    `UPDATE customer_bank_accounts SET is_active = 0 WHERE id = ?`,
    id,
  );
}
