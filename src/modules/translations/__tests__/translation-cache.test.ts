import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hermetic tests for the translation cache (M18). Prisma is mocked, no database
// is touched. Each test uses its own source string so the module-level cache
// cannot leak between tests.

const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
  process.env.JWT_SECRET ??= 'test-only-jwt-secret-0123456789';
  return {
    prisma: {
      contentTranslation: { findMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
    },
  };
});
vi.mock('../../../shared/database/prisma.js', () => ({ prisma: mocks.prisma, assertDatabaseReachable: vi.fn() }));

import { saveTranslation, sourceHash, translateBody } from '../translation.service.js';

describe('translateBody cache (M18)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('queries once for repeated translations of the same text', async () => {
    mocks.prisma.contentTranslation.findMany.mockResolvedValue([
      { sourceHash: sourceHash('Cache Mug One'), text: 'Tasse Eins' },
    ]);
    const body1 = { name: { en: 'Cache Mug One' } };
    await translateBody(body1, 'de');
    expect((body1.name as Record<string, string>).de).toBe('Tasse Eins');
    expect(mocks.prisma.contentTranslation.findMany).toHaveBeenCalledTimes(1);

    const body2 = { name: { en: 'Cache Mug One' } };
    await translateBody(body2, 'de');
    expect((body2.name as Record<string, string>).de).toBe('Tasse Eins');
    expect(mocks.prisma.contentTranslation.findMany).toHaveBeenCalledTimes(1);
  });

  it('also caches a miss, so an untranslated page costs no query twice', async () => {
    mocks.prisma.contentTranslation.findMany.mockResolvedValue([]);
    await translateBody({ name: { en: 'Cache Mug Two' } }, 'de');
    expect(mocks.prisma.contentTranslation.findMany).toHaveBeenCalledTimes(1);
    await translateBody({ name: { en: 'Cache Mug Two' } }, 'de');
    expect(mocks.prisma.contentTranslation.findMany).toHaveBeenCalledTimes(1);
  });

  it('invalidates the cached entry when the translation is saved', async () => {
    mocks.prisma.contentTranslation.findMany
      .mockResolvedValueOnce([{ sourceHash: sourceHash('Cache Mug Three'), text: 'Tasse Drei' }])
      .mockResolvedValueOnce([{ sourceHash: sourceHash('Cache Mug Three'), text: 'Becher Drei' }]);
    mocks.prisma.contentTranslation.upsert.mockResolvedValue({});
    const body1 = { name: { en: 'Cache Mug Three' } };
    await translateBody(body1, 'de');
    expect((body1.name as Record<string, string>).de).toBe('Tasse Drei');

    await saveTranslation({ source: 'Cache Mug Three', lang: 'de', text: 'Becher Drei' });
    const body2 = { name: { en: 'Cache Mug Three' } };
    await translateBody(body2, 'de');
    expect((body2.name as Record<string, string>).de).toBe('Becher Drei');
    expect(mocks.prisma.contentTranslation.findMany).toHaveBeenCalledTimes(2);
  });
});
