import bcrypt from 'bcryptjs';
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from './db.js';
import { clearCsrfCookie, issueCsrfCookie } from './csrf.js';
import { env } from './env.js';
import { unauthorized } from './http.js';

// Server-side owner authentication. The session is a signed JWT in an httpOnly cookie, so the token is
// never readable by JavaScript in the admin app. Every admin write goes through `requireOwner`.

const COOKIE = 'ys_owner_session';

export interface OwnerClaims {
  sub: string;
  email: string;
  name: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      owner?: OwnerClaims;
    }
  }
}

export const hashPassword = (plain: string) => bcrypt.hash(plain, 10);

export function issueSession(res: Response, owner: { id: string; email: string; name: string }) {
  const token = jwt.sign({ sub: owner.id, email: owner.email, name: owner.name } satisfies OwnerClaims, env.JWT_SECRET, {
    expiresIn: `${env.SESSION_TTL_HOURS}h`,
  });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    // Cookies marked Secure are dropped over plain http://localhost, so only set it in production.
    secure: env.isProd,
    maxAge: env.SESSION_TTL_HOURS * 60 * 60 * 1000,
    path: '/',
  });
  issueCsrfCookie(res, env.SESSION_TTL_HOURS * 60 * 60 * 1000);
}

export function clearSession(res: Response) {
  res.clearCookie(COOKIE, { httpOnly: true, sameSite: 'lax', secure: env.isProd, path: '/' });
  clearCsrfCookie(res);
}

function readClaims(req: Request): OwnerClaims | null {
  const raw = (req.cookies as Record<string, string> | undefined)?.[COOKIE];
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

export async function verifyOwnerCredentials(email: string, password: string) {
  const owner = await prisma.owner.findUnique({ where: { email: email.trim().toLowerCase() } });
  if (!owner) return null;
  const ok = await bcrypt.compare(password, owner.passwordHash);
  return ok ? owner : null;
}
