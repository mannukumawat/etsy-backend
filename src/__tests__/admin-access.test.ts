import type { Express } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

// Hermetic composition test: every route mounted under /api/admin — whichever module registered it —
// must reject an anonymous caller with the owner-required 401, and must do so before any database
// access. The route list is read from the live Express router stack, so a router added later is
// covered automatically. No database is touched (any Prisma call fails the test).

const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/test';
  process.env.JWT_SECRET ??= 'test-only-jwt-secret-0123456789';
  const calls: string[] = [];
  const recorder = (path: string): unknown =>
    new Proxy(function recordedPrismaMember() {}, {
      get: (_target, prop) => (typeof prop === 'string' && prop !== 'then' ? recorder(`${path}.${prop}`) : undefined),
      apply: () => {
        calls.push(path);
        throw new Error(`Unexpected database access: prisma${path}`);
      },
    });
  return { calls, prisma: recorder('') };
});
vi.mock('../shared/database/prisma.js', () => ({ prisma: mocks.prisma, assertDatabaseReachable: vi.fn() }));

import { createApp } from '../app.js';
import { UNAUTHORIZED_BODY } from './support/owner-session.js';

interface Layer {
  route?: { path: string; methods: Record<string, boolean> };
  name?: string;
  handle?: { stack?: Layer[] };
  regexp?: RegExp & { fast_slash?: boolean };
  keys?: Array<{ name: string }>;
}

/** Express 4 stores a router's mount path only as a regexp; turn it back into a path. */
function mountPath(layer: Layer): string {
  if (!layer.regexp || layer.regexp.fast_slash) return '';
  const keys = (layer.keys ?? []).map((k) => k.name);
  let i = 0;
  return layer.regexp.source
    .replace(/^\^/, '')
    .replace(/\\\/\?\(\?=\\\/\|\$\)\$?$/, '')
    .replace(/\(\?:\\\/\(\?=\$\)\)\?/g, '')
    .replace(/\\\/\?\$$/, '')
    .replace(/\(\?:\(\[\^\\\/\]\+\?\)\)/g, () => `:${keys[i++] ?? 'param'}`)
    .replace(/\\\//g, '/');
}

function collectRoutes(stack: Layer[], prefix = ''): Array<{ method: string; path: string }> {
  const found: Array<{ method: string; path: string }> = [];
  for (const layer of stack) {
    if (layer.route) {
      for (const [method, enabled] of Object.entries(layer.route.methods)) {
        if (enabled) found.push({ method, path: `${prefix}${layer.route.path}`.replace(/\/+$/, '') || '/' });
      }
    } else if (layer.name === 'router' && layer.handle?.stack) {
      found.push(...collectRoutes(layer.handle.stack, prefix + mountPath(layer)));
    }
  }
  return found;
}

const app: Express = createApp();
const adminRoutes = collectRoutes((app as unknown as { _router: { stack: Layer[] } })._router.stack).filter(
  (r) => r.path.startsWith('/api/admin') && !['/api/admin/auth/login', '/api/admin/auth/logout'].includes(r.path),
);

describe('every /api/admin route requires the owner', () => {
  it('finds the whole admin surface (sanity check on the enumeration itself)', () => {
    expect(adminRoutes.length).toBeGreaterThan(80);
    const keys = new Set(adminRoutes.map((r) => `${r.method.toUpperCase()} ${r.path}`));
    for (const expected of [
      'GET /api/admin/auth/me',
      'GET /api/admin/categories',
      'PUT /api/admin/categories/:id',
      'GET /api/admin/products',
      'PATCH /api/admin/products/:id/status',
      'DELETE /api/admin/products/all',
      'GET /api/admin/orders',
      'GET /api/admin/settings',
    ]) {
      expect(keys, expected).toContain(expected);
    }
  });

  it('answers 401 to an anonymous caller on every admin route, before any database access', async () => {
    const failures: string[] = [];
    for (const { method, path } of adminRoutes) {
      const url = path.replace(/:[A-Za-z]+/g, 'x');
      const res = await (request(app) as unknown as Record<string, (u: string) => request.Test>)[method](url);
      if (res.status !== 401 || JSON.stringify(res.body) !== JSON.stringify(UNAUTHORIZED_BODY)) {
        failures.push(`${method.toUpperCase()} ${url} -> ${res.status} ${JSON.stringify(res.body).slice(0, 120)}`);
      }
    }
    expect(failures).toEqual([]);
    expect(mocks.calls).toEqual([]);
  });

  it('also keeps paths that no router handles behind the gate', async () => {
    const res = await request(app).get('/api/admin/definitely-not-a-route');
    expect(res.status).toBe(401);
    expect(res.body).toEqual(UNAUTHORIZED_BODY);
  });
});
