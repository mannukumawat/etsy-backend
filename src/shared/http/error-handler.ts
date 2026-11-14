import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { HttpError, badRequest, conflict, notFound } from '../errors/http-error.js';

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
