import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';

/** Error with an HTTP status and a stable machine-readable code the apps can branch on. */
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public issues?: Array<{ path: string; message: string }>,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message: string, issues?: HttpError['issues']) => new HttpError(400, 'validation', message, issues);
export const unauthorized = (message = 'Sign in as the store owner to continue.') => new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'Forbidden.') => new HttpError(403, 'forbidden', message);
export const notFound = (message = 'Not found.') => new HttpError(404, 'not_found', message);
export const conflict = (message: string, issues?: HttpError['issues']) => new HttpError(409, 'conflict', message, issues);

/** Wraps an async handler so rejected promises reach the error middleware. */
export function route<T>(handler: (req: Request, res: Response) => Promise<T>) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };
}

function prismaIssue(e: { code?: string; meta?: unknown }): HttpError | null {
  if (e.code === 'P2002') {
    // PostgreSQL/SQLite report the conflicting fields as an array; MySQL reports the constraint name as
    // a single string (e.g. "orders_number_key").
    const raw = (e.meta as { target?: string[] | string } | undefined)?.target ?? [];
    const target = Array.isArray(raw) ? raw.join(', ') : raw;
    // Only name fields the forms know; never echo a raw column/index name ("PRIMARY", "orders_number_key").
    const field = target.includes('slug') ? 'slug' : target.includes('sku') ? 'sku' : target.includes('code') ? 'code' : null;
    return conflict(`That ${field ?? 'value'} is already in use.`, field ? [{ path: field, message: 'Already in use.' }] : undefined);
  }
  if (e.code === 'P2025') return notFound();
  if (e.code === 'P2003') return badRequest('A referenced record does not exist.');
  if (e.code === 'P2028') return new HttpError(503, 'database_timeout', 'The product save took too long. Please try again.');
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, issues: err.issues ?? [] } });
  }
  if (err instanceof ZodError) {
    const issues = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    return res.status(400).json({ error: { code: 'validation', message: 'Please fix the highlighted fields.', issues } });
  }
  let mapped: HttpError | null = null;
  try {
    mapped = typeof err === 'object' && err !== null ? prismaIssue(err as { code?: string; meta?: unknown }) : null;
  } catch {
    // Never let the mapper itself throw: Express's fallback handler would answer with an HTML stack
    // trace (absolute file paths included) outside production.
  }
  if (mapped) {
    return res.status(mapped.status).json({ error: { code: mapped.code, message: mapped.message, issues: mapped.issues ?? [] } });
  }
  const reference = randomUUID().slice(0, 8);
  const prismaCode = typeof err === 'object' && err !== null && 'code' in err && typeof (err as { code?: unknown }).code === 'string'
    ? (err as { code: string }).code
    : null;
  console.error(`[${reference}] Unhandled ${req.method} ${req.path}:`, err);
  return res.status(500).json({
    error: {
      code: 'server_error',
      message: prismaCode
        ? `The database could not save this product (${prismaCode}). Reference: ${reference}.`
        : `Something went wrong on the server. Reference: ${reference}.`,
      issues: [],
    },
  });
}
