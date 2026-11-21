import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hermetic tests for the Prisma-backed bank-account service (C9): Prisma and the
// encryption helper are mocked; no database is touched, no table is created here,
// and the raw-SQL methods throw if called.
const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'mysql://user:pass@localhost:3306/testdb';
  process.env.JWT_SECRET ??= 'test-only-jwt-secret-0123456789';
  return {
    prisma: {
      customerBankAccount: {
        findMany: vi.fn(async (): Promise<Array<Record<string, unknown>>> => []),
        findFirst: vi.fn(),
        create: vi.fn(async (args: { data: Record<string, unknown> }): Promise<Record<string, unknown>> => args.data),
        update: vi.fn(),
      },
      $queryRawUnsafe: vi.fn(async () => { throw new Error('raw SQL must not be used'); }),
      $executeRawUnsafe: vi.fn(async () => { throw new Error('raw SQL must not be used'); }),
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
    },
    encryptAccountNumber: vi.fn((plain: string) => `enc:${plain}`),
  };
});
vi.mock('../../../shared/database/prisma.js', () => ({ prisma: mocks.prisma, assertDatabaseReachable: vi.fn() }));
vi.mock('../bank-account.crypto.js', () => ({ encryptAccountNumber: mocks.encryptAccountNumber }));

import { addBankAccount, listBankAccounts, removeBankAccount } from '../bank-account.service.js';

const { prisma } = mocks;

const storedAccount = (overrides: Record<string, unknown> = {}) => ({
  id: 'bac-1',
  customerId: 'cust-1',
  accountHolderName: 'Test Buyer',
  accountNumberEncrypted: 'enc:12345678901',
  accountNumberLast4: '8901',
  ifscCode: 'SBIN0001234',
  isActive: true,
  createdAt: new Date('2026-11-20T00:00:00.000Z'),
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('listBankAccounts (C9)', () => {
  it('lists only the customer active accounts through the Prisma model', async () => {
    prisma.customerBankAccount.findMany.mockResolvedValue([storedAccount()]);

    const rows = await listBankAccounts('cust-1');

    expect(prisma.customerBankAccount.findMany).toHaveBeenCalledWith({
      where: { customerId: 'cust-1', isActive: true },
      orderBy: { createdAt: 'desc' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({
      id: 'bac-1',
      customer_id: 'cust-1',
      account_holder_name: 'Test Buyer',
      account_number_last4: '8901',
      is_active: 1,
    }));
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });
});

describe('addBankAccount (C9)', () => {
  const input = {
    accountHolderName: 'Test Buyer',
    accountNumber: '12345678901',
    accountNumberConfirm: '12345678901',
    ifscCode: 'sbin0001234',
  };

  it('creates the account through the Prisma model, encrypted, with the last 4 digits', async () => {
    prisma.customerBankAccount.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...storedAccount(),
      ...data,
      createdAt: new Date('2026-11-20T00:00:00.000Z'),
    }));
    const row = await addBankAccount('cust-1', input);

    expect(prisma.customerBankAccount.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        customerId: 'cust-1',
        accountHolderName: 'Test Buyer',
        accountNumberEncrypted: 'enc:12345678901',
        accountNumberLast4: '8901',
        ifscCode: 'SBIN0001234',
        isActive: true,
      }),
    });
    expect(row.account_number_last4).toBe('8901');
    expect(row.is_active).toBe(1);
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('rejects mismatched account numbers before any write', async () => {
    await expect(
      addBankAccount('cust-1', { ...input, accountNumberConfirm: '12345678902' }),
    ).rejects.toMatchObject({ code: 'validation' });
    expect(prisma.customerBankAccount.create).not.toHaveBeenCalled();
  });
});

describe('removeBankAccount (C9)', () => {
  it('soft-deletes the account (isActive false) instead of removing the row', async () => {
    prisma.customerBankAccount.findFirst.mockResolvedValue({ id: 'bac-1' });

    await removeBankAccount('cust-1', 'bac-1');

    expect(prisma.customerBankAccount.findFirst).toHaveBeenCalledWith({
      where: { id: 'bac-1', customerId: 'cust-1', isActive: true },
      select: { id: true },
    });
    expect(prisma.customerBankAccount.update).toHaveBeenCalledWith({
      where: { id: 'bac-1' },
      data: { isActive: false },
    });
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown or already-removed account', async () => {
    prisma.customerBankAccount.findFirst.mockResolvedValue(null);

    await expect(removeBankAccount('cust-1', 'bac-missing')).rejects.toMatchObject({ code: 'not_found' });
    expect(prisma.customerBankAccount.update).not.toHaveBeenCalled();
  });
});
