import { prisma } from '../../shared/database/prisma.js';
import { randomHexId } from '../../shared/utils/ids.js';
import type { ExchangeEventRow, ExchangeRequestRow } from './exchange.types.js';

export async function fetchExchangeWithEvents(exchangeId: string) {
  const [rows, events] = await Promise.all([
    prisma.$queryRawUnsafe<ExchangeRequestRow[]>(`SELECT * FROM exchange_requests WHERE id = ?`, exchangeId),
    prisma.$queryRawUnsafe<ExchangeEventRow[]>(
      `SELECT * FROM exchange_events WHERE exchange_id = ? ORDER BY created_at ASC`, exchangeId,
    ),
  ]);
  return { row: rows[0] ?? null, events };
}

export async function addExchangeEvent(exchangeId: string, type: string, actor: string, message: string, actorId?: string) {
  const id = randomHexId(12);
  await prisma.$executeRawUnsafe(
    `INSERT INTO exchange_events (id, exchange_id, type, actor, actor_id, message, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NOW(3))`,
    id, exchangeId, type, actor, actorId ?? null, message,
  );
}
