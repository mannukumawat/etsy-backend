import rateLimit, { type Options } from 'express-rate-limit';
import type { Request } from 'express';

// In-memory limiters: correct for a single backend process (this store's deployment model — see
// README). Running more than one backend instance behind a load balancer would give each instance its
// own counters, effectively multiplying the limits by the instance count — if this ever moves to a
// multi-instance deployment, swap the `store` option here for a shared one (e.g. `rate-limit-redis`).
//
// Every route below is protected by TWO independent limiters where an account identifier is available:
// a per-IP limiter (stops one source hammering many accounts) and a per-account limiter (stops
// credential stuffing / targeted abuse of one account from many rotating IPs — a single combined
// IP+email key would let an attacker reset either half to bypass it, so the two are tracked and
// enforced separately, both must pass).

function emailKey(req: Request): string {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  return email || 'no-email';
}

/** `windowMs` is the limiter's own window — used as the Retry-After estimate. express-rate-limit also
 *  sets the precise `RateLimit-Reset` response header itself (via `standardHeaders: true` below), so a
 *  client that wants the exact reset time already has it; this is a reasonable, simpler upper bound for
 *  `Retry-After`, which only needs to be "a sensible number of seconds", not exact. */
function jsonHandler(message: string, windowMs: number): Options['handler'] {
  return (_req, res) => {
    const retryAfterSeconds = Math.max(1, Math.ceil(windowMs / 1000));
    res.setHeader('Retry-After', String(retryAfterSeconds));
    res.status(429).json({
      error: {
        code: 'rate_limited',
        message,
        issues: [{ path: 'retryAfter', message: `Try again in about ${retryAfterSeconds} seconds.` }],
      },
    });
  };
}

const base = {
  standardHeaders: true, // RateLimit-*
  legacyHeaders: false,
  skipSuccessfulRequests: false,
} as const;

/** Owner and customer login: 10/min per IP, 5/min per attempted account. */
const LOGIN_WINDOW_MS = 60_000;
export const loginIpLimiter = rateLimit({
  ...base,
  windowMs: LOGIN_WINDOW_MS,
  limit: 10,
  handler: jsonHandler('Too many sign-in attempts from this network. Please wait a moment and try again.', LOGIN_WINDOW_MS),
});
export const loginAccountLimiter = rateLimit({
  ...base,
  windowMs: LOGIN_WINDOW_MS,
  limit: 5,
  keyGenerator: emailKey,
  handler: jsonHandler('Too many sign-in attempts for this account. Please wait a moment and try again.', LOGIN_WINDOW_MS),
});

/** Registration: 10/hour per IP — slows mass account creation without blocking a shared office IP. */
const REGISTER_WINDOW_MS = 60 * 60_000;
export const registerLimiter = rateLimit({
  ...base,
  windowMs: REGISTER_WINDOW_MS,
  limit: 10,
  handler: jsonHandler('Too many accounts created from this network recently. Please try again later.', REGISTER_WINDOW_MS),
});

/** Password-reset request: 5/hour per IP, 3/hour per target email (independent of whether the account
 *  exists — the route itself never reveals that either way). */
const RESET_REQUEST_WINDOW_MS = 60 * 60_000;
export const passwordResetIpLimiter = rateLimit({
  ...base,
  windowMs: RESET_REQUEST_WINDOW_MS,
  limit: 5,
  handler: jsonHandler('Too many password reset requests from this network. Please try again later.', RESET_REQUEST_WINDOW_MS),
});
export const passwordResetAccountLimiter = rateLimit({
  ...base,
  windowMs: RESET_REQUEST_WINDOW_MS,
  limit: 3,
  keyGenerator: emailKey,
  handler: jsonHandler('Too many password reset requests for this account. Please try again later.', RESET_REQUEST_WINDOW_MS),
});

/** Password-reset token verification (confirm): 10/hour per IP. The token itself is unguessable
 *  (32 random bytes), but still throttled as defense in depth. */
const RESET_CONFIRM_WINDOW_MS = 60 * 60_000;
export const passwordResetConfirmLimiter = rateLimit({
  ...base,
  windowMs: RESET_CONFIRM_WINDOW_MS,
  limit: 10,
  handler: jsonHandler('Too many attempts. Please request a new reset link.', RESET_CONFIRM_WINDOW_MS),
});

/** Guest order lookup — both the number+email "track" endpoint and the token-gated "/:id" endpoint:
 *  20/15min per IP. Generous enough for a customer refreshing their confirmation page, tight enough to
 *  make scripted number/email matching impractical. */
const ORDER_LOOKUP_WINDOW_MS = 15 * 60_000;
export const orderLookupLimiter = rateLimit({
  ...base,
  windowMs: ORDER_LOOKUP_WINDOW_MS,
  limit: 20,
  handler: jsonHandler('Too many order lookups from this network. Please wait a few minutes and try again.', ORDER_LOOKUP_WINDOW_MS),
});

/** Coupon validation: 30/10min per IP — enough for a shopper retyping a code, tight enough to make
 *  brute-forcing active coupon codes impractical. */
const COUPON_WINDOW_MS = 10 * 60_000;
export const couponValidationLimiter = rateLimit({
  ...base,
  windowMs: COUPON_WINDOW_MS,
  limit: 30,
  handler: jsonHandler('Too many coupon checks from this network. Please wait a few minutes and try again.', COUPON_WINDOW_MS),
});

/** Coarse floor over the whole public API surface — catches scraping/listing abuse that doesn't fit a
 *  more specific limiter above, without getting in the way of normal browsing. */
const PUBLIC_API_WINDOW_MS = 60_000;
export const publicApiLimiter = rateLimit({
  ...base,
  windowMs: PUBLIC_API_WINDOW_MS,
  limit: 300,
  handler: jsonHandler('Too many requests from this network. Please slow down.', PUBLIC_API_WINDOW_MS),
});

/** Review create/edit/delete: 20/hour per IP — generous for a real shopper, tight against spam. */
const REVIEW_WRITE_WINDOW_MS = 60 * 60_000;
export const reviewWriteLimiter = rateLimit({
  ...base,
  windowMs: REVIEW_WRITE_WINDOW_MS,
  limit: 20,
  handler: jsonHandler('Too many review changes from this network. Please try again later.', REVIEW_WRITE_WINDOW_MS),
});
