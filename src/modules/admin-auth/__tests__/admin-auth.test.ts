import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Hermetic regression tests for the owner session endpoints: Prisma is mocked, no database is touched.

const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
  process.env.JWT_SECRET ??= 'test-only-jwt-secret-0123456789';
  return { prisma: { owner: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn(), create: vi.fn() } } };
});
vi.mock('../../../shared/database/prisma.js', () => ({ prisma: mocks.prisma, assertDatabaseReachable: vi.fn() }));

import { createApp } from '../../../app.js';
import { CSRF_FORBIDDEN_BODY, OWNER, OWNER_PASSWORD, UNAUTHORIZED_BODY, findOwner, loginAsOwner, sessionFrom, setCookieLines, type Session } from '../../../__tests__/support/owner-session.js';

const app = createApp();

describe('owner auth (/api/admin/auth)', () => {
  let session: Session;

  beforeAll(async () => {
    // The production-recovery login path must stay inert for these tests.
    vi.stubEnv('OWNER_EMAIL', '');
    vi.stubEnv('OWNER_PASSWORD', '');
    mocks.prisma.owner.findUnique.mockImplementation(findOwner);
    session = await loginAsOwner(app);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.owner.findUnique.mockImplementation(findOwner);
  });

  describe('POST /login', () => {
    it('signs the owner in: normalised email lookup, owner payload, csrf token, httpOnly session cookie', async () => {
      const res = await request(app).post('/api/admin/auth/login').send({ email: '  Owner@Test.Example ', password: OWNER_PASSWORD });

      expect(res.status).toBe(200);
      expect(mocks.prisma.owner.findUnique).toHaveBeenCalledWith({ where: { email: 'owner@test.example' } });
      expect(res.body).toEqual({
        owner: { id: OWNER.id, email: OWNER.email, name: OWNER.name, role: 'owner' },
        csrfToken: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(JSON.stringify(res.body)).not.toContain(OWNER.passwordHash);

      const cookies = setCookieLines(res);
      const sessionCookie = cookies.find((c) => c.startsWith('ys_owner_session='));
      const csrfCookie = cookies.find((c) => c.startsWith('ys_csrf='));
      expect(sessionCookie).toMatch(/HttpOnly/);
      expect(sessionCookie).toMatch(/Path=\//);
      expect(sessionCookie).toMatch(/SameSite=Lax/);
      expect(csrfCookie).not.toMatch(/HttpOnly/); // the admin app must be able to read it back as a header
      expect(csrfCookie).toContain(res.body.csrfToken);
    });

    it('rejects a wrong password with the generic message and sets no cookie', async () => {
      const res = await request(app).post('/api/admin/auth/login').send({ email: OWNER.email, password: 'wrong password' });
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: { code: 'unauthorized', message: 'Email or password is incorrect.', issues: [] } });
      expect(setCookieLines(res)).toEqual([]);
    });

    it('answers an unknown email exactly like a wrong password (no account enumeration)', async () => {
      const res = await request(app).post('/api/admin/auth/login').send({ email: 'nobody@test.example', password: OWNER_PASSWORD });
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: { code: 'unauthorized', message: 'Email or password is incorrect.', issues: [] } });
      expect(setCookieLines(res)).toEqual([]);
    });

    it('validates the body before looking anything up', async () => {
      const res = await request(app).post('/api/admin/auth/login').send({ email: 'not-an-email', password: '' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation');
      expect(res.body.error.message).toBe('Please fix the highlighted fields.');
      expect(res.body.error.issues).toEqual(
        expect.arrayContaining([
          { path: 'email', message: 'Enter a valid email address.' },
          { path: 'password', message: 'Password is required.' },
        ]),
      );
      expect(mocks.prisma.owner.findUnique).not.toHaveBeenCalled();

      const empty = await request(app).post('/api/admin/auth/login').send({});
      expect(empty.status).toBe(400);
    });
  });

  describe('POST /logout', () => {
    it('answers ok and clears both cookies, signed in or not', async () => {
      const anonymous = await request(app).post('/api/admin/auth/logout');
      expect(anonymous.status).toBe(200);
      expect(anonymous.body).toEqual({ ok: true });

      const signedIn = await request(app).post('/api/admin/auth/logout').set('Cookie', session.cookie).set('x-csrf-token', session.csrf);
      expect(signedIn.status).toBe(200);
      expect(signedIn.body).toEqual({ ok: true });
      const cleared = setCookieLines(signedIn);
      expect(cleared.find((c) => c.startsWith('ys_owner_session='))).toMatch(/Expires=Thu, 01 Jan 1970/);
      expect(cleared.find((c) => c.startsWith('ys_csrf='))).toMatch(/Expires=Thu, 01 Jan 1970/);
    });

    it('still demands the csrf header when a session cookie is present', async () => {
      const res = await request(app).post('/api/admin/auth/logout').set('Cookie', session.cookie);
      expect(res.status).toBe(403);
      expect(res.body).toEqual(CSRF_FORBIDDEN_BODY);
    });
  });

  describe('GET /me', () => {
    it('rejects an anonymous caller', async () => {
      const res = await request(app).get('/api/admin/auth/me');
      expect(res.status).toBe(401);
      expect(res.body).toEqual(UNAUTHORIZED_BODY);
    });

    it('returns the owner and reuses the existing csrf cookie value', async () => {
      const res = await request(app).get('/api/admin/auth/me').set('Cookie', session.cookie);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ owner: { id: OWNER.id, email: OWNER.email, name: OWNER.name, role: 'owner' }, csrfToken: session.csrf });
      expect(setCookieLines(res).find((c) => c.startsWith('ys_csrf='))).toBeUndefined();
    });

    it('issues a fresh csrf cookie for a session that predates csrf protection', async () => {
      const sessionOnly = session.cookie.split('; ').filter((c) => c.startsWith('ys_owner_session=')).join('; ');
      const res = await request(app).get('/api/admin/auth/me').set('Cookie', sessionOnly);
      expect(res.status).toBe(200);
      expect(res.body.csrfToken).toMatch(/^[0-9a-f]{64}$/);
      expect(res.body.csrfToken).not.toBe(session.csrf);
      expect(sessionFrom(res).csrf).toBe(res.body.csrfToken);
    });

    it('rejects a valid cookie whose owner no longer exists', async () => {
      mocks.prisma.owner.findUnique.mockResolvedValue(null);
      const res = await request(app).get('/api/admin/auth/me').set('Cookie', session.cookie);
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: { code: 'unauthorized', message: 'This owner account no longer exists.', issues: [] } });
    });
  });
});
