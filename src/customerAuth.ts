import bcrypt from 'bcryptjs';
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from './db.js';
import { clearCsrfCookie, issueCsrfCookie } from './csrf.js';
import { env } from './env.js';
import { unauthorized } from './http.js';

// Customer authentication, independent of owner authentication (auth.ts): a separate signed httpOnly
// cookie, a separate claims shape, a separate middleware. The two sessions never interact.

const COOKIE = 'ys_customer_session';

export interface CustomerClaims {
  sub: string;
  email: string;
  name: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      customer?: CustomerClaims;
    }
  }
}

export const hashPassword = (plain: string) => bcrypt.hash(plain, 10);

export function issueCustomerSession(res: Response, customer: { id: string; email: string; name: string }) {
  const token = jwt.sign({ sub: customer.id, email: customer.email, name: customer.name } satisfies CustomerClaims, env.JWT_SECRET, {
    expiresIn: `${env.CUSTOMER_SESSION_TTL_HOURS}h`,
  });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.isProd,
    maxAge: env.CUSTOMER_SESSION_TTL_HOURS * 60 * 60 * 1000,
    path: '/',
  });
  issueCsrfCookie(res, env.CUSTOMER_SESSION_TTL_HOURS * 60 * 60 * 1000);
}

export function clearCustomerSession(res: Response) {
  res.clearCookie(COOKIE, { httpOnly: true, sameSite: 'lax', secure: env.isProd, path: '/' });
  clearCsrfCookie(res);
}

function readClaims(req: Request): CustomerClaims | null {
  const raw = (req.cookies as Record<string, string> | undefined)?.[COOKIE];
  if (!raw) return null;
  try {
    const decoded = jwt.verify(raw, env.JWT_SECRET) as jwt.JwtPayload & CustomerClaims;
    if (!decoded?.sub) return null;
    return { sub: decoded.sub, email: decoded.email, name: decoded.name };
  } catch {
    return null;
  }
}

/** Populates req.customer when a valid session exists. Never rejects — used on public routes (e.g.
 *  checkout) that behave differently for a signed-in customer but also serve guests. */
export function attachCustomer(req: Request, _res: Response, next: NextFunction) {
  const claims = readClaims(req);
  if (claims) req.customer = claims;
  next();
}

/** Gate for customer-only routes (profile, addresses, wishlist, order history). */
export async function requireCustomer(req: Request, _res: Response, next: NextFunction) {
  try {
    const claims = req.customer ?? readClaims(req);
    if (!claims) throw unauthorized('Sign in to your account to continue.');
    const customer = await prisma.customer.findUnique({ where: { id: claims.sub }, select: { id: true, email: true, name: true } });
    if (!customer) throw unauthorized('This account no longer exists.');
    req.customer = { sub: customer.id, email: customer.email, name: customer.name };
    next();
  } catch (e) {
    next(e);
  }
}

export async function verifyCustomerCredentials(email: string, password: string) {
  const customer = await prisma.customer.findUnique({ where: { email: email.trim().toLowerCase() } });
  if (!customer) return null;
  const ok = await bcrypt.compare(password, customer.passwordHash);
  return ok ? customer : null;
}
