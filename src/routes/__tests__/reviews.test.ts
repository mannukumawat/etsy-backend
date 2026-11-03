import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { env } from '../../env.js';
import { prisma } from '../../db.js';

// End-to-end review flow against the real dev database. Every customer/order/review created here is
// removed in afterAll; assertions on an existing product's rating are made as deltas from a baseline,
// so pre-existing reviews (if any) are neither touched nor assumed.

const app = createApp();
const tag = randomBytes(4).toString('hex');

function asArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw as string[];
  return typeof raw === 'string' ? [raw] : [];
}
function session(setCookie: unknown) {
  const lines = asArray(setCookie);
  const csrf = lines.find((c) => c.startsWith('ys_csrf='))?.match(/ys_csrf=([^;]+)/)?.[1] ?? '';
  return { cookie: lines.map((c) => c.split(';')[0]).join('; '), csrf };
}

type Session = ReturnType<typeof session>;
const customerIds: string[] = [];
const orderIds: string[] = [];

async function register(label: string): Promise<Session & { id: string }> {
  const res = await request(app).post('/api/customer/auth/register').send({ name: `Review ${label}`, email: `test.review.${label}.${tag}@example.test`, password: 'TestPass123' });
  expect(res.status).toBe(201);
  customerIds.push(res.body.customer.id);
  return { ...session(res.headers['set-cookie']), id: res.body.customer.id };
}

/** A minimal fictional account order containing `productId`, in the given fulfilment state. */
async function order(customerId: string, productId: string, fulfilmentStatus: string) {
  const o = await prisma.order.create({
    data: {
      number: `TST-${tag}-${orderIds.length + 1}`,
      customerId,
      customerKind: 'account',
      customerName: 'Review Tester',
      customerEmail: `order.${tag}@example.test`,
      shippingAddressJson: '{}',
      currency: 'USD',
      rateSnapshotJson: JSON.stringify({ base: 'USD', rates: { USD: 1 }, asOf: new Date().toISOString(), illustrative: true }),
      subtotal: 1000,
      total: 1000,
      shippingMethodId: 'standard',
      shippingMethodLabel: 'Standard',
      shippingMinDays: 3,
      shippingMaxDays: 6,
      paymentMethod: 'cod',
      paymentStatus: 'paid',
      fulfilmentStatus,
      lines: { create: [{ productId, variantId: 'test-variant', sku: 'TEST', nameEn: 'Test line', unitPrice: 1000, quantity: 1, lineTotal: 1000 }] },
    },
  });
  orderIds.push(o.id);
  return o;
}

const send = (s: Session, method: 'post' | 'put' | 'delete', path: string, body?: object) => {
  const r = request(app)[method](path).set('Cookie', s.cookie).set('x-csrf-token', s.csrf);
  return body ? r.send(body) : r;
};

describe('product reviews', () => {
  let product: { id: string; slug: string };
  let alice: Session & { id: string };
  let bob: Session & { id: string };
  let carol: Session & { id: string };
  let owner: Session;
  let baseline: { count: number; distribution: Record<string, number> };
  let reviewId = '';

  const publicSummary = async () => (await request(app).get(`/api/products/${product.slug}/reviews`)).body.summary as { average: number; count: number; distribution: Record<string, number> };

  beforeAll(async () => {
    product = await prisma.product.findFirstOrThrow({ where: { status: 'active', category: { isActive: true } }, select: { id: true, slug: true }, orderBy: { displayOrder: 'asc' } });
    alice = await register('alice');
    bob = await register('bob');
    carol = await register('carol');
    await order(alice.id, product.id, 'delivered');
    await order(bob.id, product.id, 'delivered');
    await order(carol.id, product.id, 'shipped'); // not delivered yet → not eligible
    const login = await request(app).post('/api/admin/auth/login').send({ email: env.OWNER_EMAIL, password: env.OWNER_PASSWORD });
    expect(login.status).toBe(200);
    owner = session(login.headers['set-cookie']);
    baseline = await publicSummary();
  });

  afterAll(async () => {
    await prisma.review.deleteMany({ where: { customerId: { in: customerIds } } });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
  });

  it('requires sign-in to submit', async () => {
    const res = await request(app).post('/api/customer/reviews').send({ productId: product.id, rating: 5 });
    expect(res.status).toBe(401);
  });

  it('reports eligibility from delivered orders only', async () => {
    const a = await request(app).get(`/api/customer/reviews/product/${product.id}`).set('Cookie', alice.cookie);
    const c = await request(app).get(`/api/customer/reviews/product/${product.id}`).set('Cookie', carol.cookie);
    expect(a.body).toEqual({ eligible: true, review: null });
    expect(c.body).toEqual({ eligible: false, review: null });
  });

  it('rejects an ineligible customer (order not delivered)', async () => {
    const res = await send(carol, 'post', '/api/customer/reviews', { productId: product.id, rating: 4 });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('not_eligible');
  });

  it('rejects ratings outside 1–5 and forged ownership/status fields', async () => {
    for (const rating of [0, 6, 3.5, '5']) {
      const res = await send(alice, 'post', '/api/customer/reviews', { productId: product.id, rating });
      expect(res.status).toBe(400);
    }
    const forged = await send(alice, 'post', '/api/customer/reviews', { productId: product.id, rating: 5, customerId: bob.id, status: 'hidden', orderId: 'x', verifiedPurchase: true });
    expect(forged.status).toBe(400);
  });

  it('rejects a mutating request without the CSRF header', async () => {
    const res = await request(app).post('/api/customer/reviews').set('Cookie', alice.cookie).send({ productId: product.id, rating: 5 });
    expect(res.status).toBe(403);
  });

  it('lets an eligible customer post once; duplicates (even concurrent) are rejected', async () => {
    const body = { productId: product.id, rating: 5, title: '<b>Lovely</b>', body: 'Great mug <script>alert(1)</script>' };
    const [r1, r2] = await Promise.all([send(alice, 'post', '/api/customer/reviews', body), send(alice, 'post', '/api/customer/reviews', body)]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([201, 409]);
    reviewId = (r1.status === 201 ? r1 : r2).body.review.id;
    expect(await prisma.review.count({ where: { customerId: alice.id, productId: product.id } })).toBe(1);
    const again = await send(alice, 'post', '/api/customer/reviews', body);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('already_reviewed');
  });

  it('shows the review publicly with no private details, text stored verbatim (rendered as text by the UI)', async () => {
    const res = await request(app).get(`/api/products/${product.slug}/reviews`);
    const mine = res.body.items.find((r: { id: string }) => r.id === reviewId);
    expect(mine).toMatchObject({ author: 'Review alice', rating: 5, title: '<b>Lovely</b>', body: 'Great mug <script>alert(1)</script>', verifiedPurchase: true, edited: false });
    expect(Object.keys(mine).sort()).toEqual(['author', 'body', 'date', 'edited', 'id', 'rating', 'title', 'verifiedPurchase']);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('@example.test');
    expect(raw).not.toContain('TST-');
    expect(raw).not.toContain(alice.id);
    expect(res.body.summary.count).toBe(baseline.count + 1);
    expect(res.body.summary.distribution['5']).toBe(baseline.distribution['5'] + 1);
  });

  it('updates the product rating fields on the product endpoints', async () => {
    const detail = await request(app).get(`/api/products/${product.slug}`);
    expect(detail.body.reviewCount).toBe(baseline.count + 1);
    const list = await request(app).get(`/api/products?ids=${product.id}`);
    expect(list.body.items[0].reviewCount).toBe(baseline.count + 1);
    expect(list.body.items[0].rating).toBe(detail.body.rating);
  });

  it("does not let another customer edit or delete someone else's review", async () => {
    const edit = await send(bob, 'put', `/api/customer/reviews/${reviewId}`, { rating: 1 });
    const del = await send(bob, 'delete', `/api/customer/reviews/${reviewId}`);
    expect(edit.status).toBe(404);
    expect(del.status).toBe(404);
    expect((await prisma.review.findUniqueOrThrow({ where: { id: reviewId } })).rating).toBe(5);
  });

  it('moves the distribution and average when the owner edits their rating', async () => {
    const bobPost = await send(bob, 'post', '/api/customer/reviews', { productId: product.id, rating: 3 });
    expect(bobPost.status).toBe(201);
    const edit = await send(alice, 'put', `/api/customer/reviews/${reviewId}`, { rating: 4, title: 'Still good', body: '' });
    expect(edit.status).toBe(200);
    const s = await publicSummary();
    expect(s.count).toBe(baseline.count + 2);
    expect(s.distribution['5']).toBe(baseline.distribution['5']);
    expect(s.distribution['4']).toBe(baseline.distribution['4'] + 1);
    expect(s.distribution['3']).toBe(baseline.distribution['3'] + 1);
    if (baseline.count === 0) expect(s.average).toBe(3.5);
    const filtered = await request(app).get(`/api/products/${product.slug}/reviews?rating=4`);
    expect(filtered.body.items.every((r: { rating: number }) => r.rating === 4)).toBe(true);
    const lowest = await request(app).get(`/api/products/${product.slug}/reviews?sort=lowest&pageSize=1`);
    expect(lowest.body.items).toHaveLength(1);
  });

  it('owner hide removes the review from every public aggregate; customer edit does not un-hide; restore brings it back', async () => {
    expect((await request(app).post(`/api/admin/reviews/${reviewId}/hide`).set('Cookie', alice.cookie).set('x-csrf-token', alice.csrf).send({ reason: 'spam' })).status).toBe(401);
    expect((await send(owner, 'post', `/api/admin/reviews/${reviewId}/hide`, { reason: '' })).status).toBe(400);

    const hide = await send(owner, 'post', `/api/admin/reviews/${reviewId}/hide`, { reason: 'Contains personal information' });
    expect(hide.status).toBe(200);
    expect(hide.body.status).toBe('hidden');
    let s = await publicSummary();
    expect(s.count).toBe(baseline.count + 1);
    expect(s.distribution['4']).toBe(baseline.distribution['4']);
    const list = await request(app).get(`/api/products/${product.slug}/reviews?pageSize=20`);
    expect(list.body.items.some((r: { id: string }) => r.id === reviewId)).toBe(false);
    expect((await request(app).get(`/api/products/${product.slug}`)).body.reviewCount).toBe(baseline.count + 1);

    const edit = await send(alice, 'put', `/api/customer/reviews/${reviewId}`, { rating: 2, title: 'edited while hidden' });
    expect(edit.body.review.status).toBe('hidden');
    s = await publicSummary();
    expect(s.count).toBe(baseline.count + 1);

    const restore = await send(owner, 'post', `/api/admin/reviews/${reviewId}/restore`, { reason: 'Customer removed the details' });
    expect(restore.status).toBe(200);
    expect(restore.body.moderation.map((m: { action: string }) => m.action)).toEqual(['hidden', 'restored']);
    expect(restore.body.rating).toBe(2); // customer's own latest rating, never rewritten by moderation
    s = await publicSummary();
    expect(s.count).toBe(baseline.count + 2);
    expect(s.distribution['2']).toBe(baseline.distribution['2'] + 1);
  });

  it('lets the owner filter the moderation list', async () => {
    const res = await request(app).get(`/api/admin/reviews?productId=${product.id}&rating=2&q=edited`).set('Cookie', owner.cookie);
    expect(res.status).toBe(200);
    expect(res.body.items.map((r: { id: string }) => r.id)).toContain(reviewId);
    expect((await request(app).get('/api/admin/reviews').set('Cookie', alice.cookie)).status).toBe(401);
    expect((await request(app).get('/api/admin/reviews')).status).toBe(401);
  });

  it('lets the author delete their review and the aggregates follow', async () => {
    const del = await send(alice, 'delete', `/api/customer/reviews/${reviewId}`);
    expect(del.status).toBe(200);
    const s = await publicSummary();
    expect(s.count).toBe(baseline.count + 1);
    expect(await prisma.reviewModerationEvent.count({ where: { reviewId } })).toBe(0);
  });
});
