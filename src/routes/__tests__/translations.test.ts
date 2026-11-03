import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { env } from '../../env.js';
import { prisma } from '../../db.js';
import { sourceHash } from '../../translations.js';

// Content translation overlay against the real dev database. Uses a dedicated test language row
// keyed by an existing category's English name; every row created here is removed afterwards and
// pre-existing translations for that text are restored.

const app = createApp();

function session(setCookie: unknown) {
  const lines = Array.isArray(setCookie) ? (setCookie as string[]) : typeof setCookie === 'string' ? [setCookie] : [];
  const csrf = lines.find((c) => c.startsWith('ys_csrf='))?.match(/ys_csrf=([^;]+)/)?.[1] ?? '';
  return { cookie: lines.map((c) => c.split(';')[0]).join('; '), csrf };
}

describe('content translations', () => {
  let category: { slug: string; nameEn: string };
  let previous: { text: string } | null;
  let owner: { cookie: string; csrf: string };

  beforeAll(async () => {
    category = await prisma.category.findFirstOrThrow({ where: { isActive: true }, select: { slug: true, nameEn: true } });
    previous = await prisma.contentTranslation.findUnique({ where: { lang_sourceHash: { lang: 'it', sourceHash: sourceHash(category.nameEn) } }, select: { text: true } });
    const login = await request(app).post('/api/admin/auth/login').send({ email: env.OWNER_EMAIL, password: env.OWNER_PASSWORD });
    owner = session(login.headers['set-cookie']);
  });

  afterAll(async () => {
    const hash = sourceHash(category.nameEn);
    if (previous) {
      await prisma.contentTranslation.upsert({
        where: { lang_sourceHash: { lang: 'it', sourceHash: hash } },
        create: { lang: 'it', sourceHash: hash, source: category.nameEn, text: previous.text },
        update: { text: previous.text },
      });
    } else await prisma.contentTranslation.deleteMany({ where: { lang: 'it', sourceHash: hash } });
  });

  const italianName = async () => {
    const res = await request(app).get('/api/categories').set('x-lang', 'it');
    return res.body.items.find((c: { slug: string }) => c.slug === category.slug).name as Record<string, string>;
  };

  it('only the owner can list or edit translations', async () => {
    expect((await request(app).get('/api/admin/translations')).status).toBe(401);
    expect((await request(app).put('/api/admin/translations').send({ source: category.nameEn, lang: 'it', text: 'x' })).status).toBe(401);
  });

  it('owner saves a translation; public responses add it only when that language is requested', async () => {
    const put = await request(app)
      .put('/api/admin/translations')
      .set('Cookie', owner.cookie)
      .set('x-csrf-token', owner.csrf)
      .send({ source: category.nameEn, lang: 'it', text: 'Nome di prova' });
    expect(put.status).toBe(200);

    expect((await italianName()).it).toBe('Nome di prova');
    expect((await italianName()).en).toBe(category.nameEn);
    const plain = await request(app).get('/api/categories');
    expect(plain.body.items.find((c: { slug: string }) => c.slug === category.slug).name.it).toBeUndefined();
    const french = await request(app).get('/api/categories').set('x-lang', 'fr');
    expect(french.body.items.find((c: { slug: string }) => c.slug === category.slug).name.it).toBeUndefined();
    const bogus = await request(app).get('/api/categories').set('x-lang', 'xx');
    expect(bogus.status).toBe(200);
  });

  it('lists the text in the admin with where it is used', async () => {
    const res = await request(app).get(`/api/admin/translations?lang=it&q=${encodeURIComponent(category.nameEn)}`).set('Cookie', owner.cookie);
    const row = res.body.items.find((r: { source: string }) => r.source === category.nameEn);
    expect(row.translations.it).toBe('Nome di prova');
    expect(row.where.join(' ')).toContain('Category');
  });

  it('empty text removes the translation (falls back to English)', async () => {
    await request(app).put('/api/admin/translations').set('Cookie', owner.cookie).set('x-csrf-token', owner.csrf).send({ source: category.nameEn, lang: 'it', text: '' });
    expect((await italianName()).it).toBeUndefined();
  });
});
