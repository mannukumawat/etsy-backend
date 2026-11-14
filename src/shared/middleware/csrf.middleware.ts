import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';
import { forbidden } from '../errors/http-error.js';

// Double-submit-cookie CSRF protection, layered on top of the SameSite=Lax session cookies.
//
// Why both: SameSite=Lax already stops the classic cross-site <form> POST and cross-site fetch/XHR
// from sending the session cookie at all in modern browsers. The double-submit token is defense in
// depth for older/misconfigured clients, and for the (plausible, for a store like this) future where
// a real payment gateway redirect or a third-party checkout embed needs a top-level navigation that
// Lax would otherwise still allow to carry the cookie on GET.
//
// Mechanism: on login, a second, NON-httpOnly cookie is issued alongside the session cookie, readable
// by the app's own JS (same-origin only — a different origin's script can never read it, regardless of
// SameSite, because cookies are not readable cross-origin at all). The frontend echoes that value back
// as a request header on every mutating call. An attacker's cross-site page can forge the request and
// (for a plain <form>) even the cookie will ride along, but it can never read the cookie's value to
// also set the matching header, so the two values won't match.
//
// Enforcement is based on req.owner/req.customer (populated by attachOwner/attachCustomer, which run
// before this middleware) rather than on "does the csrf cookie exist" — a session that predates this
// change has a valid JWT but no csrf cookie yet, and must fail closed (403, forcing a fresh login that
// issues one) rather than silently skipping the check.

export const CSRF_COOKIE = 'ys_csrf';
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function issueCsrfCookie(res: Response, maxAgeMs: number) {
  const token = randomBytes(32).toString('hex');
  res.cookie(CSRF_COOKIE, token, {
    httpOnly: false, // must be readable by the app's own JS to echo back as a header
    sameSite: env.isProd ? 'none' : 'lax',
    secure: env.isProd,
    maxAge: maxAgeMs,
    path: '/',
  });
  return token;
}

export function clearCsrfCookie(res: Response) {
  res.clearCookie(CSRF_COOKIE, { httpOnly: false, sameSite: env.isProd ? 'none' : 'lax', secure: env.isProd, path: '/' });
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Applied globally, after attachOwner/attachCustomer. A no-op for GET/HEAD/OPTIONS and for requests
 *  with no recognized session (guest checkout, login, registration all have no ambient cookie-borne
 *  authority to protect). Fails closed for every other authenticated, state-changing request. */
const AUTH_ENDPOINTS = new Set(['/api/admin/auth/login', '/api/customer/auth/login', '/api/customer/auth/register']);

export function requireCsrf(req: Request, _res: Response, next: NextFunction) {
  if (!MUTATING_METHODS.has(req.method)) return next();
  if (AUTH_ENDPOINTS.has(req.path)) return next();
  const authed = Boolean(req.owner || req.customer);
  if (!authed) return next();

  const cookieToken = (req.cookies as Record<string, string> | undefined)?.[CSRF_COOKIE];
  const headerToken = req.get('x-csrf-token');
  if (!cookieToken || !headerToken || !safeEqual(cookieToken, headerToken)) {
    return next(forbidden('Missing or invalid CSRF token. Refresh the page and try again.'));
  }
  next();
}
