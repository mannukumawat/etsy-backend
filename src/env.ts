import 'dotenv/config';
import { z } from 'zod';

// Fail fast and loudly: a half-configured API is worse than one that refuses to start.
const schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required (see .env.example).'),
  PORT: z.coerce.number().int().positive().default(4000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  CORS_ORIGINS: z.string().default('http://localhost:5173,http://localhost:5174'),
  // Express `trust proxy` setting (see https://expressjs.com/en/guide/behind-proxies.html). Controls
  // which `X-Forwarded-For` hops are trusted to determine the real client IP — used by the rate
  // limiters below. Left at `false` (no proxy) by default: in dev, and in any deployment that
  // terminates TLS directly on this process, that is correct. Behind exactly one reverse proxy
  // (nginx, a load balancer), set this to `1`. Getting this wrong in either direction either lets a
  // client spoof `X-Forwarded-For` to dodge per-IP rate limits, or makes every request look like it
  // comes from the proxy's own IP and limits everyone together — so it must be set deliberately, not
  // left on a default that happens to "work".
  TRUST_PROXY: z.string().default('false'),
  PUBLIC_API_URL: z.string().url().default('http://localhost:4000'),
  STOREFRONT_PUBLIC_URL: z.string().url().default('http://localhost:5173'),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters.'),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(12),
  OWNER_EMAIL: z.string().email().default('owner@yourstore.example'),
  OWNER_PASSWORD: z.string().min(8).default('AdminDemo2026'),
  OWNER_NAME: z.string().default('Store Owner'),

  // --- Customer sessions -------------------------------------------------------------------------
  // Reuses JWT_SECRET to sign tokens (a separate cookie name keeps the two sessions independent);
  // no extra configuration is required to run the customer-auth flow.
  CUSTOMER_SESSION_TTL_HOURS: z.coerce.number().positive().default(24 * 30),

  // --- Email (password reset) ---------------------------------------------------------------------
  // All optional. Without them, reset emails are not sent: the reset link is logged to the server
  // console and, outside production, also returned in the API response so the flow stays testable.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z.coerce.boolean().default(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().default('"Your Store" <no-reply@yourstore.example>'),

  // --- Payments ------------------------------------------------------------------------------------
  // Cash-on-delivery always works with no configuration. Card/UPI/wallet require a real gateway;
  // without one configured, checkout rejects those methods with the exact env vars needed to enable
  // them, rather than ever faking a "paid" result.
  PAYMENT_GATEWAY: z.enum(['none', 'razorpay', 'stripe']).default('none'),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  STRIPE_SECRET_KEY: z.string().optional(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  console.error(`\nInvalid backend environment:\n${details}\n\nCopy .env.example to .env and fill it in.\n`);
  process.exit(1);
}

/** `false` (no proxy, default), `true`/a bare number (trust that many hops), or anything else passed
 *  through as-is for Express's own `trust proxy` parsing (an IP, CIDR, or comma-separated list). */
function parseTrustProxy(raw: string): boolean | number | string {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'false') return false;
  if (trimmed.toLowerCase() === 'true') return true;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

export const env = {
  ...parsed.data,
  corsOrigins: parsed.data.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean),
  isProd: parsed.data.NODE_ENV === 'production',
  trustProxy: parseTrustProxy(parsed.data.TRUST_PROXY),
};

/** Absolute, restart-stable URL for a stored image. Both apps embed this. */
export const mediaUrl = (id: string) => `${env.PUBLIC_API_URL.replace(/\/$/, '')}/media/${id}`;

export const isSmtpConfigured = Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASSWORD);

export const isPaymentGatewayConfigured =
  env.PAYMENT_GATEWAY === 'razorpay'
    ? Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET)
    : env.PAYMENT_GATEWAY === 'stripe'
      ? Boolean(env.STRIPE_SECRET_KEY)
      : false;

/** Exact env vars an operator needs to set to enable a real (non-COD) payment method. */
export const paymentGatewaySetupHelp =
  'Set PAYMENT_GATEWAY=razorpay with RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET, or PAYMENT_GATEWAY=stripe with STRIPE_SECRET_KEY, in backend/.env.';
