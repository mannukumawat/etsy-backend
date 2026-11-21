import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hermetic tests for the stale-rate guard (M12). Prisma is mocked, no database
// is touched; the service file is imported only for its pure helper + constant.

const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
  process.env.JWT_SECRET ??= 'test-only-jwt-secret-0123456789';
  return {
    prisma: {
      currencyConfig: { findMany: vi.fn() },
      currencySettings: { update: vi.fn() },
    },
  };
});
vi.mock('../../../shared/database/prisma.js', () => ({ prisma: mocks.prisma, assertDatabaseReachable: vi.fn() }));

import { MAX_RATE_AGE_MS, isRateStale } from '../exchange-rate.service.js';

describe('isRateStale (M12)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is stale when rates were never synced', () => {
    expect(isRateStale(null)).toBe(true);
    expect(isRateStale(undefined)).toBe(true);
  });

  it('is fresh just after a sync and stale after the threshold', () => {
    expect(isRateStale(new Date())).toBe(false);
    expect(isRateStale(new Date(Date.now() - 23 * 60 * 60 * 1000))).toBe(false);
    expect(isRateStale(new Date(Date.now() - 25 * 60 * 60 * 1000))).toBe(true);
  });

  it('honours an explicit max age', () => {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    expect(isRateStale(tenMinutesAgo, 60 * 60 * 1000)).toBe(false);
    expect(isRateStale(tenMinutesAgo, 5 * 60 * 1000)).toBe(true);
  });

  it('the default threshold is 24 hours', () => {
    expect(MAX_RATE_AGE_MS).toBe(24 * 60 * 60 * 1000);
  });
});
