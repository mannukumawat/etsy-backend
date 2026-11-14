import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { prisma } from '../database/prisma.js';
import { unauthorized } from '../errors/http-error.js';

// Customer authentication, independent of owner authentication (auth.middleware.ts): a separate signed
// httpOnly cookie, a separate claims shape, a separate middleware. The two sessions never interact.
// Issuing/clearing the cookie and checking credentials live in modules/customers.

export const CUSTOMER_SESSION_COOKIE = 'ys_customer_session';

export interface CustomerClaims {
  sub: string;
  email: string;
  name: string;
}

declare global {
  namespace Express {
    interface Request {
      customer?: CustomerClaims;
    }
  }
}

function readClaims(req: Request): CustomerClaims | null {
  const raw = (req.cookies as Record<string, string> | undefined)?.[CUSTOMER_SESSION_COOKIE];
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
    const customer = await prisma.customer.findUnique({ where: { id: claims.sub }, select: { id: true, email: true, name: true, deletedAt: true } });
    if (!customer || customer.deletedAt !== null) throw unauthorized('This account is scheduled for deletion. Sign in to reactivate it.');
    req.customer = { sub: customer.id, email: customer.email, name: customer.name };
    next();
  } catch (e) {
    next(e);
  }
}
