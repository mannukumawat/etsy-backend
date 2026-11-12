import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Router } from 'express';
import { requireCustomer } from '../customerAuth.js';
import { prisma } from '../db.js';
import { badRequest, notFound, route } from '../http.js';
import { toPublicBankAccount, type BankAccountRow } from '../mappers.js';
import { addBankAccountSchema } from '../validation.js';

function newId() { return randomBytes(12).toString('hex'); }

function getDerivedKey(): Buffer {
  // 32-byte key: prefer BANK_ACCOUNT_KEY (64 hex chars), else derive from app secret.
  const hexKey = process.env.BANK_ACCOUNT_KEY ?? '';
  if (hexKey.length === 64 && /^[0-9a-fA-F]+$/.test(hexKey)) {
    return Buffer.from(hexKey, 'hex');
  }
  const appSecret = process.env.APP_SECRET ?? process.env.JWT_SECRET ?? 'dev-secret-change-me';
  return createHash('sha256').update(appSecret).digest();
}

function encryptAccountNumber(plain: string): string {
  const key = getDerivedKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export const customerBankAccountsRouter = Router();
customerBankAccountsRouter.use(requireCustomer);

// GET / — list saved bank accounts (masked)
customerBankAccountsRouter.get(
  '/',
  route(async (req, res) => {
    const customerId = req.customer!.sub;
    const rows = await prisma.$queryRawUnsafe<BankAccountRow[]>(
      `SELECT * FROM customer_bank_accounts WHERE customer_id = ? AND is_active = 1 ORDER BY created_at DESC`,
      customerId,
    );
    res.json({ items: rows.map(toPublicBankAccount) });
  }),
);

// POST / — add bank account
customerBankAccountsRouter.post(
  '/',
  route(async (req, res) => {
    const input = addBankAccountSchema.parse(req.body);
    const customerId = req.customer!.sub;

    if (input.accountNumber !== input.accountNumberConfirm) {
      throw badRequest('Account numbers do not match.');
    }

    const last4 = input.accountNumber.slice(-4);
    const encrypted = encryptAccountNumber(input.accountNumber);
    const id = newId();

    await prisma.$executeRawUnsafe(
      `INSERT INTO customer_bank_accounts
       (id, customer_id, account_holder_name, account_number_encrypted, account_number_last4, ifsc_code, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, NOW(3))`,
      id, customerId, input.accountHolderName.trim(), encrypted, last4, input.ifscCode.toUpperCase(),
    );

    const rows = await prisma.$queryRawUnsafe<BankAccountRow[]>(
      `SELECT * FROM customer_bank_accounts WHERE id = ?`, id,
    );
    res.status(201).json(toPublicBankAccount(rows[0]!));
  }),
);

// DELETE /:id — soft-remove bank account
customerBankAccountsRouter.delete(
  '/:id',
  route(async (req, res) => {
    const customerId = req.customer!.sub;
    const rows = await prisma.$queryRawUnsafe<BankAccountRow[]>(
      `SELECT * FROM customer_bank_accounts WHERE id = ? AND customer_id = ? AND is_active = 1`,
      req.params.id, customerId,
    );
    if (!rows[0]) throw notFound('Bank account not found.');

    // Soft-delete so existing linked return refunds are unaffected.
    await prisma.$executeRawUnsafe(
      `UPDATE customer_bank_accounts SET is_active = 0 WHERE id = ?`,
      req.params.id,
    );
    res.json({ ok: true });
  }),
);
