import { Router } from 'express';
import { clearSession, issueSession, verifyOwnerCredentials } from './admin-auth.service.js';
import { requireOwner } from '../../shared/middleware/auth.middleware.js';
import { CSRF_COOKIE, issueCsrfCookie } from '../../shared/middleware/csrf.middleware.js';
import { env } from '../../shared/config/env.js';
import { route } from '../../shared/http/async-route.js';
import { unauthorized } from '../../shared/errors/http-error.js';
import { ownerLoginAccountLimiter, ownerLoginIpLimiter, passwordResetAccountLimiter, passwordResetConfirmLimiter, passwordResetIpLimiter } from '../../shared/middleware/rate-limit.middleware.js';
import { forgotPasswordSchema, loginSchema, resetPasswordSchema } from './admin-auth.schema.js';
import { requestPasswordReset, resetPassword } from './password-reset.service.js';

export const adminAuthRouter = Router();

adminAuthRouter.post(
  '/login',
  ownerLoginIpLimiter,
  ownerLoginAccountLimiter,
  route(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
    const owner = await verifyOwnerCredentials(email, password);
    if (!owner) throw unauthorized('Email or password is incorrect.');
    const csrfToken = issueSession(res, owner);
    res.json({ owner: { id: owner.id, email: owner.email, name: owner.name, role: 'owner' }, csrfToken });
  }),
);

adminAuthRouter.post('/logout', (req, res) => {
  clearSession(res, req.cookies?.ys_owner_session);
  res.json({ ok: true });
});

/** Request a password-reset link. Always answers { ok: true, delivered } — even for
 *  unknown emails — so the endpoint never reveals whether an account exists. */
adminAuthRouter.post(
  '/forgot-password',
  passwordResetIpLimiter,
  passwordResetAccountLimiter,
  route(async (req, res) => {
    const { email } = forgotPasswordSchema.parse(req.body);
    res.json(await requestPasswordReset(email));
  }),
);

/** Consume a reset link token and set a new password. The token is single-use. */
adminAuthRouter.post(
  '/reset-password',
  passwordResetConfirmLimiter,
  route(async (req, res) => {
    const { token, password } = resetPasswordSchema.parse(req.body);
    res.json(await resetPassword(token, password, req.cookies?.ys_owner_session));
  }),
);

adminAuthRouter.get('/me', requireOwner, (req, res) => {
  const existingToken = (req.cookies as Record<string, string> | undefined)?.[CSRF_COOKIE];
  const csrfToken = existingToken || issueCsrfCookie(res, env.SESSION_TTL_HOURS * 60 * 60 * 1000);
  res.json({ owner: { id: req.owner!.sub, email: req.owner!.email, name: req.owner!.name, role: 'owner' }, csrfToken });
});
