import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { env } from '../shared/config/env.js';
import { prisma } from '../shared/database/prisma.js';

// Regression tests for the fixes from the 2026-10-31 access-control audit:
//   1. GET /api/admin/media now requires the owner (previously open to anyone).
//   2. GET /api/orders/:id now requires ownership (account) or a one-time token (guest) — an order id
//      alone no longer returns the order.
//   3. Login/registration/etc. are rate limited.
//   4. Authenticated mutating requests require a matching CSRF header.
//   5. A media row not referenced by anything public is not fetchable by its bytes URL anonymously.
//
// These run against the real dev database (see vitest.config.ts) — every record created here is
// deleted in `afterAll`, and nothing pre-existing is touched or asserted on by value.

const app = createApp();

/** superagent types `set-cookie` as a plain string, but Node (and this header specifically) always
 *  gives an array at runtime — normalize both shapes. */
function asArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw as string[];
  return typeof raw === 'string' ? [raw] : [];
}

function csrfFromSetCookie(setCookie: unknown): string {
  const line = asArray(setCookie).find((c) => c.startsWith('ys_csrf='));
  const match = line?.match(/ys_csrf=([^;]+)/);
  if (!match) throw new Error('No ys_csrf cookie in response');
  return match[1];
}

function cookieHeader(setCookie: unknown): string {
  return asArray(setCookie)
    .map((c) => c.split(';')[0])
    .join('; ');
}

describe('security regression: admin media access control', () => {
  let ownerCookies: string;
  let ownerCsrf: string;
  const createdMediaIds: string[] = [];

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/admin/auth/login')
      .send({ email: env.OWNER_EMAIL, password: env.OWNER_PASSWORD });
    expect(res.status).toBe(200);
    ownerCookies = cookieHeader(res.headers['set-cookie']);
    ownerCsrf = csrfFromSetCookie(res.headers['set-cookie']);
  });

  afterAll(async () => {
    if (createdMediaIds.length) await prisma.media.deleteMany({ where: { id: { in: createdMediaIds } } });
  });

  it('rejects anonymous GET of the media inventory (was previously open — see audit 1.1)', async () => {
    const res = await request(app).get('/api/admin/media');
    expect(res.status).toBe(401);
  });

  it('rejects a signed-in customer (not owner) from the media inventory', async () => {
    const email = `test.media.customer.${randomBytes(4).toString('hex')}@example.test`;
    const register = await request(app).post('/api/customer/auth/register').send({ name: 'Media Tester', email, password: 'TestPass123' });
    const customerCookies = cookieHeader(register.headers['set-cookie']);
    try {
      const res = await request(app).get('/api/admin/media').set('Cookie', customerCookies);
      expect(res.status).toBe(401);
    } finally {
      await prisma.customer.deleteMany({ where: { email } });
    }
  });

  it('allows the owner to list and upload media', async () => {
    const res = await request(app)
      .post('/api/admin/media')
      .set('Cookie', ownerCookies)
      .set('x-csrf-token', ownerCsrf)
      .send({ fileName: 'test-private.png', mimeType: 'image/png', base64: 'aGVsbG8td29ybGQ=', alt: { en: 'test', hi: '' } });
    expect(res.status).toBe(201);
    createdMediaIds.push(res.body.id);

    const list = await request(app).get('/api/admin/media').set('Cookie', ownerCookies);
    expect(list.status).toBe(200);
    expect(list.body.items.some((m: { id: string }) => m.id === res.body.id)).toBe(true);
  });

  it('rejects an owner-authenticated write with no/wrong CSRF header (simulated forged cross-site request)', async () => {
    const res = await request(app)
      .post('/api/admin/media')
      .set('Cookie', ownerCookies)
      .send({ fileName: 'no-csrf.png', mimeType: 'image/png', base64: 'aGVsbG8=', alt: { en: '', hi: '' } });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
  });

  it('keeps a media upload not referenced by any published content unreachable by anonymous byte fetch, but visible to the owner', async () => {
    const upload = await request(app)
      .post('/api/admin/media')
      .set('Cookie', ownerCookies)
      .set('x-csrf-token', ownerCsrf)
      .send({ fileName: 'unreferenced.png', mimeType: 'image/png', base64: 'aGVsbG8td29ybGQ=', alt: { en: '', hi: '' } });
    const id = upload.body.id;
    createdMediaIds.push(id);

    const anon = await request(app).get(`/media/${id}`);
    expect(anon.status).toBe(404);

    const owner = await request(app).get(`/media/${id}`).set('Cookie', ownerCookies);
    expect(owner.status).toBe(200);
    expect(owner.headers['cache-control']).toBe('private, no-store');
  });

  it('maps a MySQL unique-constraint violation to a JSON 409, never an HTML stack trace', async () => {
    const existing = await prisma.category.findFirst({ select: { slug: true } });
    if (!existing) return;
    const res = await request(app)
      .post('/api/admin/categories')
      .set('Cookie', ownerCookies)
      .set('x-csrf-token', ownerCsrf)
      .send({ slug: existing.slug, name: { en: 'Duplicate', hi: '' }, description: { en: '', hi: '' } });
    expect(res.status).toBe(409);
    expect(res.headers['content-type']).toContain('application/json');
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/\bat \S+ \(|\.ts:\d|node_modules/); // no stack frames / file paths
    expect(body).not.toMatch(/PRIMARY|_key\b/); // no raw MySQL index names
  });

  it('serves a product-referenced image publicly with long-lived caching', async () => {
    const product = await prisma.product.findFirst({ where: { status: 'active' }, include: { images: true } });
    if (!product?.images[0]) return; // no seeded products in this environment — nothing to assert
    const res = await request(app).get(`/media/${product.images[0].mediaId}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('public');
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin'); // storefront/admin <img> on other ports
    expect(res.headers['content-security-policy']).toContain('sandbox'); // a directly-opened SVG can't script
  });
});

describe('security regression: order access control', () => {
  const createdCustomerEmails: string[] = [];
  const createdOrderIds: string[] = [];
  // Placing an order really decrements stock, and deleting the order afterwards does not give it back —
  // so every unit a test consumes is returned in afterAll, leaving catalog stock exactly as it was.
  const consumed = new Map<string, number>();

  afterAll(async () => {
    await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
    await prisma.customer.deleteMany({ where: { email: { in: createdCustomerEmails } } });
    for (const [variantId, qty] of consumed) {
      await prisma.productVariant.update({ where: { id: variantId }, data: { stock: { increment: qty } } });
    }
  });

  async function pickInStockVariant() {
    const variant = await prisma.productVariant.findFirst({
      where: { stock: { gte: 5 }, product: { status: 'active', category: { isActive: true } } },
      select: { id: true, productId: true },
    });
    if (!variant) throw new Error('No active, in-stock variant to test against — seed the catalog first.');
    return variant;
  }

  function recordOrder(status: number, body: { id?: string }, variantId: string) {
    if (status !== 201 || !body.id) return;
    createdOrderIds.push(body.id);
    consumed.set(variantId, (consumed.get(variantId) ?? 0) + 1);
  }

  async function placeGuestOrder(email: string) {
    const variant = await pickInStockVariant();
    const res = await request(app)
      .post('/api/checkout/orders')
      .send({
        idempotencyKey: `test-${randomBytes(8).toString('hex')}`,
        lines: [{ productId: variant.productId, variantId: variant.id, quantity: 1 }],
        currency: 'USD',
        email,
        address: { fullName: 'Test Guest', phoneCountry: 'IN', phone: '9876500000', country: 'IN', line1: '1 Test Rd' },
        shippingMethodId: 'standard',
        paymentMethod: 'cod',
      });
    recordOrder(res.status, res.body, variant.id);
    expect(res.status).toBe(201);
    return res.body as { id: string; accessToken?: string };
  }

  it('mints a one-time access token for a guest order and requires it for GET /api/orders/:id', async () => {
    const email = `test.guest.${randomBytes(4).toString('hex')}@example.test`;
    const order = await placeGuestOrder(email);
    expect(order.accessToken).toBeTruthy();

    const noToken = await request(app).get(`/api/orders/${order.id}`);
    expect(noToken.status).toBe(404); // the previously-vulnerable path: id alone must not work

    const wrongToken = await request(app).get(`/api/orders/${order.id}`).set('x-order-token', 'not-the-right-token');
    expect(wrongToken.status).toBe(404);

    const rightToken = await request(app).get(`/api/orders/${order.id}`).set('x-order-token', order.accessToken!);
    expect(rightToken.status).toBe(200);
    expect(rightToken.headers['cache-control']).toBe('private, no-store');
  });

  it('rejects an expired guest token', async () => {
    const email = `test.guest.expired.${randomBytes(4).toString('hex')}@example.test`;
    const order = await placeGuestOrder(email);
    await prisma.order.update({ where: { id: order.id }, data: { guestTokenExpiresAt: new Date(Date.now() - 1000) } });

    const res = await request(app).get(`/api/orders/${order.id}`).set('x-order-token', order.accessToken!);
    expect(res.status).toBe(404);
  });

  it("does not let customer B read customer A's account order by id, but lets A read it", async () => {
    const emailA = `test.acctA.${randomBytes(4).toString('hex')}@example.test`;
    const emailB = `test.acctB.${randomBytes(4).toString('hex')}@example.test`;
    createdCustomerEmails.push(emailA, emailB);

    const regA = await request(app).post('/api/customer/auth/register').send({ name: 'Test A', email: emailA, password: 'TestPass123' });
    const regB = await request(app).post('/api/customer/auth/register').send({ name: 'Test B', email: emailB, password: 'TestPass123' });
    const cookiesA = cookieHeader(regA.headers['set-cookie']);
    const csrfA = csrfFromSetCookie(regA.headers['set-cookie']);
    const cookiesB = cookieHeader(regB.headers['set-cookie']);

    const variant = await pickInStockVariant();

    const placed = await request(app)
      .post('/api/checkout/orders')
      .set('Cookie', cookiesA)
      .set('x-csrf-token', csrfA)
      .send({
        idempotencyKey: `test-${randomBytes(8).toString('hex')}`,
        lines: [{ productId: variant.productId, variantId: variant.id, quantity: 1 }],
        currency: 'USD',
        email: emailA,
        address: { fullName: 'Test A', phoneCountry: 'IN', phone: '9876500001', country: 'IN', line1: '1 A Rd' },
        shippingMethodId: 'standard',
        paymentMethod: 'cod',
      });
    recordOrder(placed.status, placed.body, variant.id);
    expect(placed.status).toBe(201);
    expect(placed.body.accessToken).toBeUndefined(); // account orders get no guest token

    const bReads = await request(app).get(`/api/orders/${placed.body.id}`).set('Cookie', cookiesB);
    expect(bReads.status).toBe(404);

    const anonReads = await request(app).get(`/api/orders/${placed.body.id}`);
    expect(anonReads.status).toBe(404);

    const aReads = await request(app).get(`/api/orders/${placed.body.id}`).set('Cookie', cookiesA);
    expect(aReads.status).toBe(200);
  });

  it('still places orders after an earlier order row was deleted (order number must not reuse a live one)', async () => {
    const first = await placeGuestOrder(`test.num1.${randomBytes(4).toString('hex')}@example.test`);
    await placeGuestOrder(`test.num2.${randomBytes(4).toString('hex')}@example.test`);
    await prisma.order.delete({ where: { id: first.id } });
    const third = await placeGuestOrder(`test.num3.${randomBytes(4).toString('hex')}@example.test`);
    expect(third.id).toBeTruthy();
  });

  it('trims PII from the public number+email tracking lookup', async () => {
    const email = `test.track.${randomBytes(4).toString('hex')}@example.test`;
    const order = await placeGuestOrder(email);
    const full = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });

    const res = await request(app).get('/api/orders/track').query({ number: full.number, email });
    expect(res.status).toBe(200);
    expect(res.body.email).toBe('');
    expect(res.body.phone).toBe('');
    expect(res.body.address.line1).toBe('');
    expect(res.body.address.phone).toBe('');
  });
});

describe('security regression: rate limiting', () => {
  it('returns 429 with Retry-After after repeated failed owner login attempts for one account', async () => {
    const attempts = Array.from({ length: 7 }, (_, i) =>
      request(app).post('/api/admin/auth/login').send({ email: 'rate-limit-test@example.test', password: `wrong-${i}` }),
    );
    const results = [];
    for (const attempt of attempts) results.push(await attempt); // sequential: this IS the thing under test
    const limited = results.filter((r) => r.status === 429);
    expect(limited.length).toBeGreaterThan(0);
    expect(limited[0].headers['retry-after']).toBeTruthy();
  });
});
