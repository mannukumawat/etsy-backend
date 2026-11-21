/**
 * Observability tests (M19): structured JSON logger, request IDs, request
 * logging, readiness and metrics.
 *
 * These tests deliberately build a minimal Express app from the observability
 * modules instead of importing `createApp()`: `createApp()` pulls in the Prisma
 * client, which cannot be generated in this environment (prisma generate fails
 * with ECONNRESET), so an app-level import would fail test collection here.
 * The `createApp()` wiring itself (middleware order, health mount point) is
 * verified by typecheck + lint + code review, and by the live server once the
 * environment allows it.
 */
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHealthRouter } from '../health.js';
import { logger, setLogSink } from '../logger.js';
import { getMetricsSnapshot, resetMetrics } from '../metrics.js';
import { requestId, requestLogger } from '../request-logging.js';

function buildTestApp(checkDatabase: () => Promise<void>) {
  const app = express();
  app.use(requestId);
  app.use(requestLogger);
  app.use('/api/health', createHealthRouter({ checkDatabase }));
  app.get('/ok', (_req, res) => res.json({ ok: true }));
  app.get('/fail', (_req, res) => res.status(500).json({ error: 'failed' }));
  app.use((_req, res) => res.status(404).json({ error: 'not found' }));
  return app;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('structured logger', () => {
  const lines: string[] = [];
  const originalLevel = process.env.LOG_LEVEL;

  beforeEach(() => {
    lines.length = 0;
    process.env.LOG_LEVEL = 'info';
    setLogSink((line) => lines.push(line));
  });

  afterEach(() => {
    setLogSink(null);
    process.env.LOG_LEVEL = originalLevel;
  });

  it('emits one single-line JSON object per call with time, level and message', () => {
    logger.info('hello', { requestId: 'req-1', status: 200 });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(parsed.level).toBe('info');
    expect(parsed.msg).toBe('hello');
    expect(parsed.requestId).toBe('req-1');
    expect(parsed.status).toBe(200);
    expect(typeof parsed.time).toBe('string');
    expect(lines[0]).not.toContain('\n');
  });

  it('suppresses lines below LOG_LEVEL and keeps lines at or above it', () => {
    process.env.LOG_LEVEL = 'error';
    logger.info('hidden');
    logger.warn('also hidden');
    logger.error('shown', { error: 'boom' });
    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0]!) as { level: string }).level).toBe('error');
  });

  it('falls back to info for an invalid LOG_LEVEL', () => {
    process.env.LOG_LEVEL = 'verbose';
    logger.info('shown');
    logger.debug('hidden');
    expect(lines).toHaveLength(1);
  });
});

describe('requestId middleware', () => {
  it('echoes a valid incoming X-Request-Id onto the response', async () => {
    const app = buildTestApp(async () => {});
    const res = await request(app).get('/ok').set('x-request-id', 'client-trace-123');
    expect(res.headers['x-request-id']).toBe('client-trace-123');
  });

  it('generates a UUID when no request ID is sent', async () => {
    const app = buildTestApp(async () => {});
    const res = await request(app).get('/ok');
    expect(res.headers['x-request-id']).toMatch(UUID_PATTERN);
  });

  it('generates a UUID when the incoming ID contains characters outside the allowed set', async () => {
    const app = buildTestApp(async () => {});
    const res = await request(app).get('/ok').set('x-request-id', 'not a valid id!');
    expect(res.headers['x-request-id']).toMatch(UUID_PATTERN);
  });
});

describe('request logging and metrics', () => {
  const lines: string[] = [];

  beforeEach(() => {
    lines.length = 0;
    resetMetrics();
    process.env.LOG_LEVEL = 'info';
    setLogSink((line) => lines.push(line));
  });

  afterEach(() => {
    setLogSink(null);
  });

  it('logs one request-completed line per request with method, path, status, duration and the same request ID as the response header', async () => {
    const app = buildTestApp(async () => {});
    const res = await request(app).get('/ok').set('x-request-id', 'trace-9');
    expect(res.headers['x-request-id']).toBe('trace-9');
    const completed = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((p) => p.msg === 'request completed');
    expect(completed).toBeDefined();
    expect(completed).toMatchObject({ method: 'GET', path: '/ok', status: 200, requestId: 'trace-9' });
    expect(typeof completed!.durationMs).toBe('number');
  });

  it('counts requests by route and status, counts 5xx separately, and collapses ID-like path segments', async () => {
    const app = buildTestApp(async () => {});
    await request(app).get('/ok');
    await request(app).get('/ok');
    await request(app).get('/fail');
    await request(app).get('/api/products/12345');
    await request(app).get('/api/products/67890');
    const res = await request(app).get('/api/health/metrics');
    expect(res.status).toBe(200);
    const snapshot = res.body as ReturnType<typeof getMetricsSnapshot>;
    expect(snapshot.totalRequests).toBe(5);
    expect(snapshot.requests5xx).toBe(1);
    const ok = snapshot.routes.find((r) => r.route === '/ok' && r.method === 'GET');
    expect(ok?.total).toBe(2);
    expect(ok?.byStatus['200']).toBe(2);
    const product = snapshot.routes.find((r) => r.route === '/api/products/:id');
    expect(product?.total).toBe(2);
    expect(product?.byStatus['404']).toBe(2);
  });
});

describe('health router', () => {
  it('answers 200 ready when the database check succeeds', async () => {
    const app = buildTestApp(async () => {});
    const res = await request(app).get('/api/health/ready');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, status: 'ready', service: 'your-store-backend' });
  });

  it('answers 503 not_ready when the database check fails', async () => {
    const app = buildTestApp(async () => {
      throw new Error('connection refused');
    });
    const res = await request(app).get('/api/health/ready');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ ok: false, status: 'not_ready', error: 'database_unreachable' });
  });

  it('exposes metrics as JSON', async () => {
    const app = buildTestApp(async () => {});
    const res = await request(app).get('/api/health/metrics');
    expect(res.status).toBe(200);
    expect(res.body.service).toBe('your-store-backend');
    expect(typeof res.body.uptimeSeconds).toBe('number');
    expect(Array.isArray(res.body.routes)).toBe(true);
  });
});
