import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { prisma } from '../database/prisma.js';
import { CUSTOMER_ISSUER, TOKEN_AUDIENCE, isRevoked } from '../auth/revocation.js';
import { unauthorized } from '../errors/http-error.js';

// Customer authentication, independent of owner authentication (auth.middleware.ts): a separate signed
// httpOnly cookie, a separate claims shape, a separate middleware. The two sessions never interact.
// Issuing/clearing the cookie and checking credentials live in modules/customers.

export const CUSTOMER_SESSION_COOKIE = 'ys_customer_session';

export interface CustomerClaims {
  sub: string;
  email: string;
  name: string;
  /** Per-token id (M15). Absent on legacy tokens issued before revocation landed. */
  jti?: string;
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
    // M15: reject tokens minted for the other realm, or for a different audience. Tokens
    // issued before iss/aud were added carry neither claim and are still accepted during
    // the transition — they expire within 7 days and cannot be minted any more.
    if (decoded.iss !== undefined && decoded.iss !== CUSTOMER_ISSUER) return null;
    if (decoded.aud !== undefined && decoded.aud !== TOKEN_AUDIENCE) return null;
    return { sub: decoded.sub, email: decoded.email, name: decoded.name, jti: decoded.jti };
  } catch {
    return null;
  }
}

/** Populates req.customer when a valid session exists. Never rejects — used on public routes (e.g.
 *  checkout) that behave differently for a signed-in customer but also serve guests. Revocation is
 *  NOT checked here (this runs synchronously) — the requireCustomer gate below is the enforcement
 *  point for customer-only routes. */
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
    // M15: a revoked token (logout / password change) is rejected even though its
    // signature is still valid. Legacy tokens without a jti have nothing to revoke.
    if (claims.jti && (await isRevoked(claims.jti))) throw unauthorized('Sign in to your account to continue.');
    const customer = await prisma.customer.findUnique({ where: { id: claims.sub }, select: { id: true, email: true, name: true, deletedAt: true } });
    if (!customer || customer.deletedAt !== null) throw unauthorized('This account is scheduled for deletion. Sign in to reactivate it.');
    req.customer = { sub: customer.id, email: customer.email, name: customer.name };
    next();
  } catch (e) {
    next(e);
  }
}
