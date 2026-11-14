import bcrypt from 'bcryptjs';
import type { Express } from 'express';
import request from 'supertest';

// Helpers for the hermetic admin route tests (Prisma is mocked there, no database is touched).

export const OWNER_PASSWORD = 'correct horse battery staple';

/** The owner row the mocked `prisma.owner.findUnique` returns. */
export const OWNER = {
  id: 'owner_test',
  email: 'owner@test.example',
  name: 'Test Owner',
  passwordHash: bcrypt.hashSync(OWNER_PASSWORD, 4),
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

/** Mock implementation for `prisma.owner.findUnique`: resolves the owner by email or id, else null. */
export const findOwner = async ({ where }: { where: { id?: string; email?: string } }) =>
  where.id === OWNER.id || where.email === OWNER.email ? OWNER : null;

export interface Session {
  /** Value for the Cookie request header (session + csrf cookies). */
  cookie: string;
  /** Value for the x-csrf-token request header. */
  csrf: string;
}

function asArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw as string[];
  return typeof raw === 'string' ? [raw] : [];
}

export function setCookieLines(res: { headers: Record<string, unknown> }): string[] {
  return asArray(res.headers['set-cookie']);
}

export function sessionFrom(res: { headers: Record<string, unknown> }): Session {
  const lines = setCookieLines(res);
  const csrf = lines.find((c) => c.startsWith('ys_csrf='))?.match(/ys_csrf=([^;]+)/)?.[1] ?? '';
  return { cookie: lines.map((c) => c.split(';')[0]).join('; '), csrf };
}

export async function loginAsOwner(app: Express): Promise<Session> {
  const res = await request(app).post('/api/admin/auth/login').send({ email: OWNER.email, password: OWNER_PASSWORD });
  if (res.status !== 200) throw new Error(`owner login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return sessionFrom(res);
}

/** The JSON error envelope every failing endpoint answers with. */
export const UNAUTHORIZED_BODY = {
  error: { code: 'unauthorized', message: 'Sign in as the store owner to continue.', issues: [] },
};
export const CSRF_FORBIDDEN_BODY = {
  error: { code: 'forbidden', message: 'Missing or invalid CSRF token. Refresh the page and try again.', issues: [] },
};
