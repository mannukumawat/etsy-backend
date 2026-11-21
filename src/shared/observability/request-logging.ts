import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { logger } from './logger.js';
import { recordRequest } from './metrics.js';

/**
 * Request IDs + request logging (M19). Registered first in `createApp()`, so
 * every request — including ones rejected later by auth/rate limiting — carries
 * an ID and is logged once, on completion, as one JSON line:
 * `{ method, path, status, durationMs, requestId }`.
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by `requestId` middleware; read by the error handler and webhook handlers for log correlation. */
      requestId?: string;
    }
  }
}

/** Incoming IDs are trusted only when they look like an ID — anything else gets a fresh UUID, so a client can never inject newlines or control characters into a log line. */
const INCOMING_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  const id = incoming !== undefined && INCOMING_ID_PATTERN.test(incoming) ? incoming : randomUUID();
  req.requestId = id;
  res.setHeader('x-request-id', id);
  next();
}

/** Route keys for metrics: use the matched Express route when one exists, otherwise the raw path with ID-like segments collapsed so `/api/products/abc123` does not create a new counter per product. */
const ID_SEGMENT = /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{20,})$/i;

function routeKey(req: Request): string {
  if (req.route?.path) {
    const routePath = typeof req.route.path === 'string' ? req.route.path : req.route.path.join(',');
    return `${req.baseUrl}${routePath}`;
  }
  return req.path
    .split('/')
    .map((segment) => (ID_SEGMENT.test(segment) ? ':id' : segment))
    .join('/');
}

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const startedAt = Date.now();
  res.on('finish', () => {
    const durationMs = Date.now() - startedAt;
    recordRequest(req.method, routeKey(req), res.statusCode);
    logger.info('request completed', {
      requestId: req.requestId ?? null,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs,
    });
  });
  next();
}
