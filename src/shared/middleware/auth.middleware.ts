import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { prisma } from '../database/prisma.js';
import { unauthorized } from '../errors/http-error.js';

// Server-side owner authentication. The session is a signed JWT in an httpOnly cookie, so the token is
// never readable by JavaScript in the admin app. Every admin write goes through `requireOwner`.
// Issuing/clearing the cookie and checking credentials live in modules/admin-auth.

export const OWNER_SESSION_COOKIE = 'ys_owner_session';

export interface OwnerClaims {
  sub: string;
  email: string;
  name: string;
}

declare global {
  namespace Express {
    interface Request {
      owner?: OwnerClaims;
    }
  }
}

function readClaims(req: Request): OwnerClaims | null {
  const raw = (req.cookies as Record<string, string> | undefined)?.[OWNER_SESSION_COOKIE];
  if (!raw) return null;
  try {
    const decoded = jwt.verify(raw, env.JWT_SECRET) as jwt.JwtPayload & OwnerClaims;
    if (!decoded?.sub) return null;
    return { sub: decoded.sub, email: decoded.email, name: decoded.name };
  } catch {
    return null;
  }
}

/** Populates req.owner when a valid session exists. Never rejects. */
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
    const owner = await prisma.owner.findUnique({ where: { id: claims.sub }, select: { id: true, email: true, name: true } });
    if (!owner) throw unauthorized('This owner account no longer exists.');
    req.owner = { sub: owner.id, email: owner.email, name: owner.name };
    next();
  } catch (e) {
    next(e);
  }
}
