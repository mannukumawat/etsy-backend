import { prisma } from '../../shared/database/prisma.js';
import { env } from '../../shared/config/env.js';

// Live exchange-rate sync. Pulls "1 USD = x" rates from a free, key-less public feed and writes them into
// the currencies the owner marked as "Live" (CurrencyConfig.autoRate). Currencies left on manual are never
// touched. If every feed is down, the previous rates stay in place and the failure is recorded for the admin.

interface Source {
  name: string;
  url: string;
  pick: (json: unknown) => Record<string, unknown> | null;
}

const SOURCES: Source[] = [
  {
    name: 'open.er-api.com',
    url: 'https://open.er-api.com/v6/latest/USD',
    pick: (j) => {
      const o = j as { result?: string; rates?: Record<string, unknown> };
      return o?.result === 'success' && o.rates ? o.rates : null;
    },
  },
  {
    name: 'frankfurter.app',
    url: 'https://api.frankfurter.app/latest?from=USD',
    pick: (j) => (j as { rates?: Record<string, unknown> })?.rates ?? null,
  },
];

async function fetchUsdRates(): Promise<{ source: string; rates: Record<string, unknown> }> {
  const failures: string[] = [];
  for (const src of SOURCES) {
    try {
      const res = await fetch(src.url, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rates = src.pick(await res.json());
      if (!rates) throw new Error('unexpected response');
      return { source: src.name, rates };
    } catch (e) {
      failures.push(`${src.name}: ${e instanceof Error ? e.message : 'failed'}`);
    }
  }
  throw new Error(`Could not reach a live rate feed (${failures.join('; ')}).`);
}

export interface RateSyncResult {
  source: string;
  updated: Array<{ code: string; from: number; to: number }>;
  skipped: string[];
}

/**
 * Maximum age of exchange rates checkout may rely on (M12). Live sync runs every
 * 6 hours on a long-running server and daily via Vercel Cron, so 24 hours covers
 * a missed run with slack; anything older means sync has been failing for a day.
 * The checkout agent enforces this (checkout.service.ts must refuse or warn when
 * `isRateStale(ratesUpdatedAt)` — see the snippet in the backend-fix report);
 * this module only records the timestamp and owns the rule.
 */
export const MAX_RATE_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Pure stale-rate check: true when rates have never been synced or the last
 * successful sync is older than `maxAgeMs` (defaults to MAX_RATE_AGE_MS).
 * `ratesUpdatedAt` is the `CurrencySettings.ratesUpdatedAt` timestamp.
 */
export function isRateStale(ratesUpdatedAt: Date | null | undefined, maxAgeMs: number = MAX_RATE_AGE_MS): boolean {
  if (!ratesUpdatedAt) return true;
  return Date.now() - ratesUpdatedAt.getTime() > maxAgeMs;
}

/** Refreshes every non-USD currency that has `autoRate` on. Throws (after recording the error) if no feed answers. */
export async function syncLiveRates(): Promise<RateSyncResult> {
  const configs = await prisma.currencyConfig.findMany({ where: { settingsId: 'singleton', autoRate: true, code: { not: 'USD' } } });
  if (!configs.length) return { source: '', updated: [], skipped: [] };

  try {
    const { source, rates } = await fetchUsdRates();
    const updated: RateSyncResult['updated'] = [];
    const skipped: string[] = [];
    for (const c of configs) {
      const raw = rates[c.code];
      const next = typeof raw === 'number' ? raw : NaN;
      // Never store nonsense: a missing / zero / absurd value keeps the previous rate.
      if (!Number.isFinite(next) || next <= 0 || next > 100_000) {
        skipped.push(c.code);
        continue;
      }
      const rounded = Math.round(next * 1e6) / 1e6;
      if (rounded === c.rate) continue;
      await prisma.currencyConfig.update({ where: { id: c.id }, data: { rate: rounded } });
      updated.push({ code: c.code, from: c.rate, to: rounded });
    }
    // ratesUpdatedAt records every successful sync — not only syncs that changed a
    // value — so the stale-rate guard (isRateStale, M12) measures time since rates
    // were last confirmed current, not time since a value happened to move.
    await prisma.currencySettings.update({
      where: { id: 'singleton' },
      data: { autoSyncAt: new Date(), ratesUpdatedAt: new Date(), autoSyncError: skipped.length ? `No live rate for ${skipped.join(', ')}; kept the previous value.` : '' },
    });
    return { source, updated, skipped };
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Live rate sync failed.';
    await prisma.currencySettings.update({ where: { id: 'singleton' }, data: { autoSyncAt: new Date(), autoSyncError: message.slice(0, 300) } }).catch(() => undefined);
    throw e;
  }
}

const SIX_HOURS = 6 * 60 * 60 * 1000;

/** In-process refresh for a long-running server. Serverless hosts (Vercel) cannot keep a timer alive, so they use the cron endpoint instead. */
export function startRateScheduler() {
  if (process.env.VERCEL || env.CURRENCY_AUTO_SYNC === 'false') return;
  const run = () =>
    syncLiveRates()
      .then((r) => {
        if (r.updated.length) console.log(`[rates] updated ${r.updated.map((u) => `${u.code} ${u.from}→${u.to}`).join(', ')} (${r.source})`);
      })
      .catch((e) => console.warn(`[rates] sync failed: ${e instanceof Error ? e.message : e}`));
  setTimeout(run, 15_000).unref();
  setInterval(run, SIX_HOURS).unref();
}
