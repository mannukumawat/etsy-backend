import bcrypt from 'bcryptjs';
import type { Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../../shared/config/env.js';
import { prisma } from '../../shared/database/prisma.js';
import { clearCsrfCookie, issueCsrfCookie } from '../../shared/middleware/csrf.middleware.js';
import { OWNER_SESSION_COOKIE, type OwnerClaims } from '../../shared/middleware/auth.middleware.js';

export function issueSession(res: Response, owner: { id: string; email: string; name: string }) {
  const token = jwt.sign({ sub: owner.id, email: owner.email, name: owner.name } satisfies OwnerClaims, env.JWT_SECRET, {
    expiresIn: `${env.SESSION_TTL_HOURS}h`,
  });
  res.cookie(OWNER_SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: env.isProd ? 'none' : 'lax',
    secure: env.isProd,
    maxAge: env.SESSION_TTL_HOURS * 60 * 60 * 1000,
    path: '/',
  });
  return issueCsrfCookie(res, env.SESSION_TTL_HOURS * 60 * 60 * 1000);
}

export function clearSession(res: Response) {
  res.clearCookie(OWNER_SESSION_COOKIE, { httpOnly: true, sameSite: env.isProd ? 'none' : 'lax', secure: env.isProd, path: '/' });
  clearCsrfCookie(res);
}

export async function verifyOwnerCredentials(email: string, password: string) {
  const normalizedEmail = email.trim().toLowerCase();
  const owner = await prisma.owner.findUnique({ where: { email: normalizedEmail } });
  if (owner && (await bcrypt.compare(password, owner.passwordHash))) return owner;

  // Production recovery/bootstrap: the deploy-time owner secrets are authoritative when explicitly
  // configured. This lets a single-seller deployment recover from a stale seeded password without
  // direct database access. Defaults are deliberately excluded, so forgetting to configure Vercel
  // can never make the documented demo credentials a production back door.
  const configuredEmail = process.env.OWNER_EMAIL?.trim().toLowerCase();
  const configuredPassword = process.env.OWNER_PASSWORD;
  if (!configuredEmail || !configuredPassword || normalizedEmail !== configuredEmail || password !== configuredPassword) return null;

  const passwordHash = await bcrypt.hash(configuredPassword, 10);
  if (owner) {
    return prisma.owner.update({
      where: { id: owner.id },
      data: { passwordHash, name: process.env.OWNER_NAME?.trim() || owner.name },
    });
  }

  // This is a single-owner store. If an earlier seed used another email, migrate that row instead of
  // silently creating a second administrator.
  const existingOwner = await prisma.owner.findFirst({ orderBy: { createdAt: 'asc' } });
  if (existingOwner) {
    return prisma.owner.update({
      where: { id: existingOwner.id },
      data: { email: configuredEmail, passwordHash, name: process.env.OWNER_NAME?.trim() || existingOwner.name },
    });
  }

  return prisma.owner.create({
    data: {
      id: `owner_${Date.now().toString(36)}`,
      email: configuredEmail,
      passwordHash,
      name: process.env.OWNER_NAME?.trim() || 'Store_Owner',
    },
  });
}
