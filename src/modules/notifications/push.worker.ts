/**
 * Push delivery worker.
 *
 * Polls notification_records with pushStatus='pending' and createdAt < NOW()-5s,
 * looks up the recipient's FCM tokens, sends the notification, and marks the record.
 *
 * On VPS: `startPushWorker()` → setInterval every 30s.
 * On Vercel: the cron GET /api/notifications/cron/push-flush (vercel.json, hourly) is the
 * single flush path — it calls flushPendingPush() directly. There is no owner POST flush
 * endpoint any more (it was behind the owner gate, so Vercel Cron could never call it).
 */
import { timingSafeEqual } from 'node:crypto';
import { prisma } from '../../shared/database/prisma.js';
import { env } from '../../shared/config/env.js';
import { sendToTokens } from './fcm.service.js';

const BUFFER_MS = 5_000; // 5 s buffer so a customer reading immediately doesn't get a push
const BATCH_SIZE = 50;
const MAX_PASSES = 10; // loop-until-empty cap: 10 passes × 50 records drains any realistic backlog

/** One pass: process at most BATCH_SIZE pending records. Returns how many were processed. */
async function flushPendingPushBatch(): Promise<{ processed: number }> {
  const cutoff = new Date(Date.now() - BUFFER_MS);

  const pending = await prisma.notificationRecord.findMany({
    where: { pushStatus: 'pending', createdAt: { lt: cutoff } },
    orderBy: { createdAt: 'asc' },
    take: BATCH_SIZE,
  });

  if (pending.length === 0) return { processed: 0 };

  // Group by recipientId
  const byRecipient = new Map<string, typeof pending>();
  for (const rec of pending) {
    const list = byRecipient.get(rec.recipientId) ?? [];
    list.push(rec);
    byRecipient.set(rec.recipientId, list);
  }

  let processed = 0;

  for (const [recipientId, records] of byRecipient) {
    // Fetch FCM tokens for this recipient
    const tokenRows = recipientId === 'owner'
      ? [] // owner does not get push yet (no owner FCM token table)
      : await prisma.fcmToken.findMany({ where: { customerId: recipientId }, select: { token: true } });

    const tokens = tokenRows.map((r) => r.token);

    for (const rec of records) {
      // Skip if already read (customer read before push fired)
      if (rec.readAt !== null) {
        await prisma.notificationRecord.update({ where: { id: rec.id }, data: { pushStatus: 'skipped' } });
        processed++;
        continue;
      }

      if (tokens.length === 0) {
        await prisma.notificationRecord.update({ where: { id: rec.id }, data: { pushStatus: 'no_token' } });
        processed++;
        continue;
      }

      const { sent, failed } = await sendToTokens(tokens, rec.title, rec.body, rec.link);
      const status = sent > 0 ? 'sent' : failed > 0 ? 'failed' : 'no_token';
      await prisma.notificationRecord.update({ where: { id: rec.id }, data: { pushStatus: status } });
      processed++;
    }
  }

  return { processed };
}

/**
 * Drain the pending-push queue: repeat single passes until one processes 0 records, with
 * a cap of MAX_PASSES so a pathological backlog cannot run unbounded in one invocation.
 * Both the VPS interval worker and the Vercel cron GET call this — one invocation clears
 * the backlog instead of leaving everything past the first 50 for the next day/hour.
 */
export async function flushPendingPush(): Promise<{ processed: number }> {
  let total = 0;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const { processed } = await flushPendingPushBatch();
    total += processed;
    if (processed === 0) break;
  }
  return { processed: total };
}

/** Start the 30-second push worker timer (VPS / long-running process). */
export function startPushWorker(): void {
  setInterval(() => {
    flushPendingPush().catch((err) => {
      console.error('[push-worker] error:', err instanceof Error ? err.message : err);
    });
  }, 30_000);
  console.log('[push-worker] started (30s interval)');
}

/** Validate CRON_SECRET for Vercel Cron requests. Returns true if valid. Compared in
 *  constant time (same pattern as the settings cron in settings.service.ts). */
export function validateCronSecret(authHeader: string | undefined): boolean {
  if (!env.CRON_SECRET) return false;
  const given = Buffer.from(authHeader ?? '');
  const expected = Buffer.from(`Bearer ${env.CRON_SECRET}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
