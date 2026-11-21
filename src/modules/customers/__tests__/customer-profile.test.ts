import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../app.js';
import { prisma } from '../../../shared/database/prisma.js';

const app = createApp();
const tag = randomBytes(8).toString('hex');
const emails = {
  a: `test.profile.a.${tag}@example.test`,
  b: `test.profile.b.${tag}@example.test`,
};

function sessionFrom(res: { headers: Record<string, unknown> }) {
  const raw = res.headers['set-cookie'];
  const lines = Array.isArray(raw) ? raw as string[] : typeof raw === 'string' ? [raw] : [];
  const cookie = lines.map((line) => line.split(';')[0]).join('; ');
  const csrf = lines.find((line) => line.startsWith('ys_customer_csrf='))?.match(/^ys_customer_csrf=([^;]+)/)?.[1];
  if (!cookie.includes('ys_customer_session=') || !csrf) throw new Error('Customer session cookies were not issued.');
  return { cookie, csrf };
}

const address = (label: string, isDefault = false) => ({
  label,
  isDefault,
  fullName: 'Profile Tester',
  phoneCountry: 'IN',
  phone: '9876543210',
  country: 'IN',
  line1: `${label} Street 1`,
  line2: '',
  city: 'Jaipur',
  region: 'Rajasthan',
  postalCode: '302001',
});

describe('customer profile and address integration', () => {
  let sessionA: ReturnType<typeof sessionFrom>;
  let sessionB: ReturnType<typeof sessionFrom>;

  beforeAll(async () => {
    const registerA = await request(app).post('/api/customer/auth/register').send({
      name: 'Profile Tester A', email: emails.a, phone: '9876543210', password: 'ProfilePass123',
    });
    const registerB = await request(app).post('/api/customer/auth/register').send({
      name: 'Profile Tester B', email: emails.b, phone: '9876543211', password: 'ProfilePass123',
    });
    expect(registerA.status).toBe(201);
    expect(registerB.status).toBe(201);
    sessionA = sessionFrom(registerA);
    sessionB = sessionFrom(registerB);
  }, 30_000);

  afterAll(async () => {
    await prisma.customer.deleteMany({ where: { email: { in: [emails.a, emails.b] } } });
  }, 30_000);

  it('persists profile edits and rejects email conflicts and invalid phones', async () => {
    const updated = await request(app)
      .put('/api/customer/profile')
      .set('Cookie', sessionA.cookie)
      .set('x-csrf-token', sessionA.csrf)
      .send({
        name: 'Updated Profile A', email: emails.a.toUpperCase(), phone: '+91 98765 43210',
        gender: 'Prefer not to say', languages: 'Hindi, English', occupation: 'Designer',
        pincode: '302001', city: 'Jaipur', state: 'Rajasthan', dateOfBirth: '1990-01-01',
        maritalStatus: 'Single', numberOfKids: '0', education: 'Graduate', monthlyIncome: '50000',
      });
    expect(updated.status).toBe(200);
    expect(updated.body.customer).toMatchObject({
      name: 'Updated Profile A', email: emails.a, phone: '+91 98765 43210', city: 'Jaipur', occupation: 'Designer',
    });

    const restored = await request(app).get('/api/customer/profile').set('Cookie', sessionA.cookie);
    expect(restored.status).toBe(200);
    expect(restored.body.customer).toMatchObject({ name: 'Updated Profile A', email: emails.a, city: 'Jaipur' });

    const conflict = await request(app)
      .put('/api/customer/profile')
      .set('Cookie', sessionA.cookie)
      .set('x-csrf-token', sessionA.csrf)
      .send({ name: 'Updated Profile A', email: emails.b, phone: '9876543210' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.issues).toContainEqual({ path: 'email', message: 'Already registered.' });

    const invalidPhone = await request(app)
      .put('/api/customer/profile')
      .set('Cookie', sessionA.cookie)
      .set('x-csrf-token', sessionA.csrf)
      .send({ name: 'Updated Profile A', email: emails.a, phone: '12-invalid' });
    expect(invalidPhone.status).toBe(400);
    expect(invalidPhone.body.error.issues).toContainEqual({ path: 'phone', message: 'Enter a valid phone number.' });
  });

  it('adds, edits, defaults and deletes addresses with exactly one default', async () => {
    const first = await request(app)
      .put('/api/customer/addresses')
      .set('Cookie', sessionA.cookie)
      .set('x-csrf-token', sessionA.csrf)
      .send(address('Home'));
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(1);
    expect(first.body.items[0]).toMatchObject({ label: 'Home', isDefault: true });

    const second = await request(app)
      .put('/api/customer/addresses')
      .set('Cookie', sessionA.cookie)
      .set('x-csrf-token', sessionA.csrf)
      .send(address('Work', true));
    expect(second.status).toBe(200);
    expect(second.body.items).toHaveLength(2);
    expect(second.body.items.filter((item: { isDefault: boolean }) => item.isDefault)).toHaveLength(1);
    expect(second.body.items[0].label).toBe('Work');

    const home = second.body.items.find((item: { label: string }) => item.label === 'Home');
    const edited = await request(app)
      .put('/api/customer/addresses')
      .set('Cookie', sessionA.cookie)
      .set('x-csrf-token', sessionA.csrf)
      .send({ ...address('Home edited'), id: home.id });
    expect(edited.status).toBe(200);
    expect(edited.body.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: home.id, label: 'Home edited' })]));

    const currentDefault = edited.body.items.find((item: { isDefault: boolean }) => item.isDefault);
    const deleted = await request(app)
      .delete(`/api/customer/addresses/${currentDefault.id}`)
      .set('Cookie', sessionA.cookie)
      .set('x-csrf-token', sessionA.csrf);
    expect(deleted.status).toBe(200);
    expect(deleted.body.items).toHaveLength(1);
    expect(deleted.body.items[0].isDefault).toBe(true);
  }, 60_000);

  it("does not let one customer edit or delete another customer's address", async () => {
    const created = await request(app)
      .put('/api/customer/addresses')
      .set('Cookie', sessionB.cookie)
      .set('x-csrf-token', sessionB.csrf)
      .send(address('Private B'));
    const privateId = created.body.items[0].id;

    const edit = await request(app)
      .put('/api/customer/addresses')
      .set('Cookie', sessionA.cookie)
      .set('x-csrf-token', sessionA.csrf)
      .send({ ...address('Stolen'), id: privateId });
    expect(edit.status).toBe(404);

    const remove = await request(app)
      .delete(`/api/customer/addresses/${privateId}`)
      .set('Cookie', sessionA.cookie)
      .set('x-csrf-token', sessionA.csrf);
    expect(remove.status).toBe(404);

    const stillOwned = await request(app).get('/api/customer/addresses').set('Cookie', sessionB.cookie);
    expect(stillOwned.body.items).toEqual([expect.objectContaining({ id: privateId, label: 'Private B' })]);
  });
});
