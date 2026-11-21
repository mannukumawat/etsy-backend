import { prisma } from '../../shared/database/prisma.js';
import { badRequest, conflict } from '../../shared/errors/http-error.js';
import type { Prisma } from '@prisma/client';

// Core wallet balance and ledger logic.
// All amounts in INR paise (integer). Negative balances are NEVER permitted.
// Every mutation uses a Prisma transaction so the balance and ledger row are always consistent.

/** Returns the current balance in paise for a customer (0 if no wallet row yet). */
export async function getBalance(customerId: string): Promise<number> {
  const bal = await prisma.walletBalance.findUnique({ where: { customerId } });
  return bal?.balancePaise ?? 0;
}

/**
 * Atomically credit the wallet and append a ledger row.
 * Returns the new balance after the credit.
 * @param tx  Pass a Prisma transaction client to run inside a larger transaction.
 */
export async function creditWallet(
  customerId: string,
  amountPaise: number,
  type: 'topup' | 'refund' | 'reversal',
  reference: string,
  opts: { topupId?: string; orderId?: string; note?: string; tx?: Prisma.TransactionClient },
): Promise<{ newBalance: number; txId: string }> {
  if (amountPaise <= 0) throw badRequest('Credit amount must be positive.');

  const run = async (db: Prisma.TransactionClient) => {
    // Upsert balance with atomic increment
    const updated = await db.walletBalance.upsert({
      where: { customerId },
      update: { balancePaise: { increment: amountPaise } },
      create: { customerId, balancePaise: amountPaise },
    });

    const ledgerEntry = await db.walletTransaction.create({
      data: {
        customerId,
        type,
        amountPaise,
        balanceAfter: updated.balancePaise,
        reference,
        topupId: opts.topupId ?? null,
        orderId: opts.orderId ?? null,
        note: opts.note ?? null,
      },
    });

    return { newBalance: updated.balancePaise, txId: ledgerEntry.id };
  };

  if (opts.tx) return run(opts.tx);
  return prisma.$transaction(run);
}

/**
 * Atomically debit the wallet and append a ledger row.
 * Throws 409 if the balance would go negative.
 * Returns the new balance.
 */
export async function debitWallet(
  customerId: string,
  amountPaise: number,
  type: 'spend' | 'reversal',
  reference: string,
  opts: { orderId?: string; note?: string; tx?: Prisma.TransactionClient },
): Promise<{ newBalance: number; txId: string }> {
  if (amountPaise <= 0) throw badRequest('Debit amount must be positive.');

  const run = async (db: Prisma.TransactionClient) => {
    // Lock the row with a raw UPDATE that also validates sufficiency atomically.
    // updateMany returns count=0 if the WHERE fails (insufficient balance).
    const result = await db.walletBalance.updateMany({
      where: {
        customerId,
        balancePaise: { gte: amountPaise },
      },
      data: { balancePaise: { decrement: amountPaise } },
    });

    if (result.count === 0) {
      // Either row doesn't exist or balance is insufficient
      const bal = await db.walletBalance.findUnique({ where: { customerId } });
      const available = bal?.balancePaise ?? 0;
      throw conflict(`Insufficient wallet balance. Available: ₹${(available / 100).toFixed(2)}, required: ₹${(amountPaise / 100).toFixed(2)}.`);
    }

    // Re-read to get exact new balance (the updateMany doesn't return updated values)
    const updated = await db.walletBalance.findUniqueOrThrow({ where: { customerId } });

    const ledgerEntry = await db.walletTransaction.create({
      data: {
        customerId,
        type,
        amountPaise: -amountPaise, // negative = debit
        balanceAfter: updated.balancePaise,
        reference,
        orderId: opts.orderId ?? null,
        note: opts.note ?? null,
      },
    });

    return { newBalance: updated.balancePaise, txId: ledgerEntry.id };
  };

  if (opts.tx) return run(opts.tx);
  return prisma.$transaction(run);
}

/** Lists wallet transactions for a customer, paginated. */
export async function listTransactions(customerId: string, page: number, pageSize: number) {
  const [items, total] = await Promise.all([
    prisma.walletTransaction.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.walletTransaction.count({ where: { customerId } }),
  ]);
  return { items, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}
