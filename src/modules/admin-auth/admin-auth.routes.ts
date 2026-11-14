import { Router } from 'express';
import { clearSession, issueSession, verifyOwnerCredentials } from './admin-auth.service.js';
import { requireOwner } from '../../shared/middleware/auth.middleware.js';
import { CSRF_COOKIE, issueCsrfCookie } from '../../shared/middleware/csrf.middleware.js';
import { env } from '../../shared/config/env.js';
import { route } from '../../shared/http/async-route.js';
import { unauthorized } from '../../shared/errors/http-error.js';
import { loginAccountLimiter, loginIpLimiter } from '../../shared/middleware/rate-limit.middleware.js';
import { loginSchema } from './admin-auth.schema.js';

export const adminAuthRouter = Router();

adminAuthRouter.post(
  '/login',
  loginIpLimiter,
  loginAccountLimiter,
  route(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
    const owner = await verifyOwnerCredentials(email, password);
    if (!owner) throw unauthorized('Email or password is incorrect.');
    const csrfToken = issueSession(res, owner);
    res.json({ owner: { id: owner.id, email: owner.email, name: owner.name, role: 'owner' }, csrfToken });
  }),
);

adminAuthRouter.post('/logout', (_req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

adminAuthRouter.get('/me', requireOwner, (req, res) => {
  const existingToken = (req.cookies as Record<string, string> | undefined)?.[CSRF_COOKIE];
  const csrfToken = existingToken || issueCsrfCookie(res, env.SESSION_TTL_HOURS * 60 * 60 * 1000);
  res.json({ owner: { id: req.owner!.sub, email: req.owner!.email, name: req.owner!.name, role: 'owner' }, csrfToken });
});
