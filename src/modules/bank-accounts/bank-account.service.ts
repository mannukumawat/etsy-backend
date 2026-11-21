import { prisma } from '../../shared/database/prisma.js';
import { badRequest, notFound } from '../../shared/errors/http-error.js';
import { randomHexId } from '../../shared/utils/ids.js';
import { encryptAccountNumber } from './bank-account.crypto.js';
import type { BankAccountRow } from './bank-account.mapper.js';
import type { AddBankAccountInput } from './bank-account.schema.js';

// Customer bank accounts, backed by the Prisma CustomerBankAccount model (the
// table is created by the Prisma migration — no CREATE TABLE IF NOT EXISTS here).
// The mapper still consumes the snake_case row shape, so this module maps the
// Prisma model onto that shape at the boundary.

function toBankAccountRow(a: {
  id: string; customerId: string; accountHolderName: string;
  accountNumberEncrypted: string; accountNumberLast4: string;
  ifscCode: string; isActive: boolean; createdAt: Date;
}): BankAccountRow {
  return {
    id: a.id,
    customer_id: a.customerId,
    account_holder_name: a.accountHolderName,
    account_number_encrypted: a.accountNumberEncrypted,
    account_number_last4: a.accountNumberLast4,
    ifsc_code: a.ifscCode,
    is_active: a.isActive ? 1 : 0,
    created_at: a.createdAt,
  };
}

export async function listBankAccounts(customerId: string) {
  const rows = await prisma.customerBankAccount.findMany({
    where: { customerId, isActive: true },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(toBankAccountRow);
}

export async function addBankAccount(customerId: string, input: AddBankAccountInput) {
  if (input.accountNumber !== input.accountNumberConfirm) {
    throw badRequest('Account numbers do not match.');
  }

  const last4 = input.accountNumber.slice(-4);
  const encrypted = encryptAccountNumber(input.accountNumber);
  const id = randomHexId(12);

  const created = await prisma.customerBankAccount.create({
    data: {
      id,
      customerId,
      accountHolderName: input.accountHolderName.trim(),
      accountNumberEncrypted: encrypted,
      accountNumberLast4: last4,
      ifscCode: input.ifscCode.toUpperCase(),
      isActive: true,
    },
  });
  return toBankAccountRow(created);
}

export async function removeBankAccount(customerId: string, id: string) {
  const existing = await prisma.customerBankAccount.findFirst({
    where: { id, customerId, isActive: true },
    select: { id: true },
  });
  if (!existing) throw notFound('Bank account not found.');

  // Soft-delete so existing linked return refunds are unaffected.
  await prisma.customerBankAccount.update({
    where: { id },
    data: { isActive: false },
  });
}
