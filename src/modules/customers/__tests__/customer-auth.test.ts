import { randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../app.js';
import { createRealOwnerFixture, type RealOwnerFixture } from '../../../__tests__/support/real-owner.js';
import { prisma } from '../../../shared/database/prisma.js';
import { env } from '../../../shared/config/env.js';
import { sha256Hex } from '../../../shared/utils/crypto.js';

const app = createApp();
const tag = randomBytes(8).toString('hex');
const email = `test.customer.auth.${tag}@example.test`;
const password = 'CustomerPass123';

function setCookieLines(res: { headers: Record<string, unknown> }): string[] {
  const raw = res.headers['set-cookie'];
  if (Array.isArray(raw)) return raw as string[];
  return typeof raw === 'string' ? [raw] : [];
}

function sessionFrom(res: { headers: Record<string, unknown> }) {
  const lines = setCookieLines(res);
  const cookie = lines.map((line) => line.split(';')[0]).join('; ');
  const csrfLine = lines.find((line) => line.startsWith('ys_customer_csrf='));
  const csrf = csrfLine?.match(/^ys_customer_csrf=([^;]+)/)?.[1];
  if (!cookie.includes('ys_customer_session=') || !csrf) throw new Error('Customer session cookies were not issued.');
  return { cookie, csrf };
}

describe('customer auth integration', () => {
  let owner: RealOwnerFixture;

  beforeAll(async () => {
    owner = await createRealOwnerFixture('customer-separation');
  });

  afterAll(async () => {
    await prisma.customer.deleteMany({ where: { email } });
    await owner.cleanup();
  });

  it('registers, restores the session, logs out, and logs back in', async () => {
    const register = await request(app).post('/api/customer/auth/register').send({
      name: 'Customer Auth Tester',
      email: `  ${email.toUpperCase()}  `,
      phone: '+91 98765 43210',
      password,
    });
    expect(register.status).toBe(201);
    expect(register.body.customer).toMatchObject({ email, name: 'Customer Auth Tester', phone: '+91 98765 43210' });
    expect(JSON.stringify(register.body)).not.toContain('passwordHash');

    const cookieLines = setCookieLines(register);
    const sessionLine = cookieLines.find((line) => line.startsWith('ys_customer_session='));
    const csrfLine = cookieLines.find((line) => line.startsWith('ys_customer_csrf='));
    expect(sessionLine).toMatch(/HttpOnly/);
    expect(sessionLine).toMatch(/Path=\//);
    expect(sessionLine).toMatch(/SameSite=Lax/);
    expect(csrfLine).not.toMatch(/HttpOnly/);

    const firstSession = sessionFrom(register);
    const restored = await request(app).get('/api/customer/auth/me').set('Cookie', firstSession.cookie);
    expect(restored.status).toBe(200);
    expect(restored.body.customer.email).toBe(email);

    const logout = await request(app)
      .post('/api/customer/auth/logout')
      .set('Cookie', firstSession.cookie)
      .set('x-csrf-token', firstSession.csrf);
    expect(logout.status).toBe(200);
    expect(setCookieLines(logout).find((line) => line.startsWith('ys_customer_session='))).toMatch(/Expires=Thu, 01 Jan 1970/);

    const afterLogout = await request(app).get('/api/customer/auth/me');
    expect(afterLogout.status).toBe(401);

    const login = await request(app).post('/api/customer/auth/login').send({ email: email.toUpperCase(), password });
    expect(login.status).toBe(200);
    const secondSession = sessionFrom(login);
    const restoredAgain = await request(app).get('/api/customer/auth/me').set('Cookie', secondSession.cookie);
    expect(restoredAgain.status).toBe(200);
    expect(restoredAgain.body.customer.email).toBe(email);
  });

  it('rejects a duplicate email without creating a second account', async () => {
    const duplicate = await request(app).post('/api/customer/auth/register').send({
      name: 'Duplicate Customer', email: email.toUpperCase(), password,
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.issues).toContainEqual({ path: 'email', message: 'Already registered.' });
    expect(await prisma.customer.count({ where: { email } })).toBe(1);
  });

  it.each([
    [{ name: 'A', email: 'not-an-email', phone: '', password: 'short' }, ['name', 'email', 'password']],
    [{ name: 'Valid Name', email: `invalid-phone.${tag}@example.test`, phone: '12x', password }, ['phone']],
    [{ name: 'Valid Name', email: `weak-password.${tag}@example.test`, phone: '', password: 'abcdefgh' }, ['password']],
  ])('validates invalid registration input %#', async (body, paths) => {
    const res = await request(app).post('/api/customer/auth/register').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation');
    const issuePaths = res.body.error.issues.map((issue: { path: string }) => issue.path);
    expect(issuePaths).toEqual(expect.arrayContaining(paths));
  });

  it('does not accept customer credentials at admin login or owner credentials at customer login', async () => {
    const customerAtAdmin = await request(app).post('/api/admin/auth/login').send({ email, password });
    expect(customerAtAdmin.status).toBe(401);

    const ownerAtCustomer = await request(app).post('/api/customer/auth/login').send({ email: owner.email, password: owner.password });
    expect(ownerAtCustomer.status).toBe(401);
  });

  it('rejects a customer session cookie on the owner session endpoint', async () => {
    const login = await request(app).post('/api/customer/auth/login').send({ email, password });
    const customerSession = sessionFrom(login);
    const ownerMe = await request(app).get('/api/admin/auth/me').set('Cookie', customerSession.cookie);
    expect(ownerMe.status).toBe(401);
  });

  it('requires CSRF for an authenticated customer write and rejects an expired session', async () => {
    const login = await request(app).post('/api/customer/auth/login').send({ email, password });
    const active = sessionFrom(login);

    const missingCsrf = await request(app).post('/api/customer/auth/logout').set('Cookie', active.cookie);
    expect(missingCsrf.status).toBe(403);
    expect(missingCsrf.body.error.code).toBe('forbidden');

    const customer = await prisma.customer.findUniqueOrThrow({ where: { email } });
    const expiredJwt = jwt.sign(
      { sub: customer.id, email: customer.email, name: customer.name },
      env.JWT_SECRET,
      { expiresIn: -1 },
    );
    const expired = await request(app)
      .get('/api/customer/auth/me')
      .set('Cookie', `ys_customer_session=${expiredJwt}`);
    expect(expired.status).toBe(401);
  });

  it('requests and completes a one-use password reset, then signs in with the new password', async () => {
    const unknown = await request(app)
      .post('/api/customer/auth/password-reset/request')
      .send({ email: `unknown.${tag}@example.test` });
    expect(unknown.status).toBe(200);
    expect(unknown.body).toEqual({ ok: true });

    const requested = await request(app).post('/api/customer/auth/password-reset/request').send({ email });
    expect(requested.status).toBe(200);
    expect(requested.body).toEqual({ ok: true });

    const customer = await prisma.customer.findUniqueOrThrow({ where: { email } });
    const issued = await prisma.passwordResetToken.findFirstOrThrow({
      where: { customerId: customer.id, usedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    expect(issued.expiresAt.getTime()).toBeGreaterThan(Date.now());

    // The production database deliberately stores only a hash. Replace that hash with a known
    // fixture token so the public confirmation endpoint can be exercised without exposing secrets.
    const resetToken = `test-reset-${randomBytes(16).toString('hex')}`;
    await prisma.passwordResetToken.update({ where: { id: issued.id }, data: { tokenHash: sha256Hex(resetToken) } });

    const newPassword = 'NewCustomerPass456';
    const confirmed = await request(app)
      .post('/api/customer/auth/password-reset/confirm')
      .send({ token: resetToken, password: newPassword });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toEqual({ ok: true });

    const reused = await request(app)
      .post('/api/customer/auth/password-reset/confirm')
      .send({ token: resetToken, password: 'AnotherPass789' });
    expect(reused.status).toBe(400);

    const oldLogin = await request(app).post('/api/customer/auth/login').send({ email, password });
    expect(oldLogin.status).toBe(401);
    const newLogin = await request(app).post('/api/customer/auth/login').send({ email, password: newPassword });
    expect(newLogin.status).toBe(200);
    expect(sessionFrom(newLogin).cookie).toContain('ys_customer_session=');
  });

  // Keep this last: the IP limiter is intentionally shared across login accounts and remains active
  // for the lifetime of this app instance after the threshold is crossed.
  it('rate limits repeated failed customer logins and includes Retry-After', async () => {
    const attempts = [];
    for (let i = 0; i < 8; i += 1) {
      attempts.push(await request(app).post('/api/customer/auth/login').send({
        email: `rate-limit.${tag}@example.test`, password: `WrongPass${i}`,
      }));
    }
    const limited = attempts.find((res) => res.status === 429);
    expect(limited).toBeDefined();
    expect(limited!.headers['retry-after']).toBeTruthy();
  });
});
