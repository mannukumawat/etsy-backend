import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { prisma } from '../database/prisma.js';
import { OWNER_ISSUER, TOKEN_AUDIENCE, isRevoked } from '../auth/revocation.js';
import { unauthorized } from '../errors/http-error.js';

// Server-side owner authentication. The session is a signed JWT in an httpOnly cookie, so the token is
// never readable by JavaScript in the admin app. Every admin write goes through `requireOwner`.
// Issuing/clearing the cookie and checking credentials live in modules/admin-auth.

export const OWNER_SESSION_COOKIE = 'ys_owner_session';

export interface OwnerClaims {
  sub: string;
  email: string;
  name: string;
  /** Per-token id (M15). Absent on legacy tokens issued before revocation landed. */
  jti?: string;
}

declare global {
  namespace Express {
    interface Request {
      owner?: OwnerClaims;
    }
  }
}

function readClaims(req: Request): OwnerClaims | null {
  const authHeader = req.header('authorization');
  const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const raw = bearer || (req.cookies as Record<string, string> | undefined)?.[OWNER_SESSION_COOKIE];
  if (!raw) return null;
  try {
    const decoded = jwt.verify(raw, env.JWT_SECRET) as jwt.JwtPayload & OwnerClaims;
    if (!decoded?.sub) return null;
    // M15: reject tokens minted for the other realm, or for a different audience. Tokens
    // issued before iss/aud were added carry neither claim and are still accepted during
    // the transition — they expire within 12h and cannot be minted any more.
    if (decoded.iss !== undefined && decoded.iss !== OWNER_ISSUER) return null;
    if (decoded.aud !== undefined && decoded.aud !== TOKEN_AUDIENCE) return null;
    return { sub: decoded.sub, email: decoded.email, name: decoded.name, jti: decoded.jti };
  } catch {
    return null;
  }
}

/** Populates req.owner when a valid session exists. Never rejects. Revocation is NOT checked
 *  here (this runs synchronously on public routes too) — the requireOwner gate below is the
 *  enforcement point for anything that needs an authenticated owner. */
export function attachOwner(req: Request, _res: Response, next: NextFunction) {
  const claims = readClaims(req);
  if (claims) req.owner = claims;
  next();
}

/** Gate for every admin write. Verifies the signed cookie AND that the owner still exists. */
export async function requireOwner(req: Request, _res: Response, next: NextFunction) {
  try {
    const claims = req.owner ?? readClaims(req);
    if (!claims) throw unauthorized();
    // M15: a revoked token (logout / password change) is rejected even though its
    // signature is still valid. Legacy tokens without a jti have nothing to revoke.
    if (claims.jti && (await isRevoked(claims.jti))) throw unauthorized();
    const owner = await prisma.owner.findUnique({ where: { id: claims.sub }, select: { id: true, email: true, name: true } });
    if (!owner) throw unauthorized('This owner account no longer exists.');
    req.owner = { sub: owner.id, email: owner.email, name: owner.name };
    next();
  } catch (e) {
    next(e);
  }
}
