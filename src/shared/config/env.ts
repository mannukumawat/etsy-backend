import 'dotenv/config';
import { z } from 'zod';

// Fail fast and loudly: a half-configured API is worse than one that refuses to start.
const schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required (see .env.example).'),
  DATABASE_CONNECTION_LIMIT: z.coerce.number().int().min(1).max(10).default(1),
  DATABASE_POOL_TIMEOUT_SECONDS: z.coerce.number().int().min(5).max(60).default(20),
  PORT: z.coerce.number().int().positive().default(4000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // Structured JSON log level (M19): debug | info | warn | error. Read by
  // src/shared/observability/logger.ts; invalid values fall back to info there.
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
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
  // Admin app base URL — the password-reset email links here (the admin runs on 5174 in dev).
  ADMIN_APP_URL: z.string().url().default('http://localhost:5174'),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters.'),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(12),
  OWNER_EMAIL: z.string().email().default('owner@yourstore.example'),
  // No default is safe in production (see the refine below): an unset OWNER_PASSWORD
  // fails startup outside dev/test instead of seeding a publicly-known password.
  OWNER_PASSWORD: z.string().min(8).default('AdminDemo2026'),
  OWNER_NAME: z.string().default('Store Owner'),

  // --- Live currency rates -----------------------------------------------------------------------
  // The server refreshes "Live" currencies every 6 hours. Set CURRENCY_AUTO_SYNC=false to disable the timer.
  // On Vercel (no timers) set CRON_SECRET: Vercel Cron then calls /api/settings/cron/currency-rates daily.
  CURRENCY_AUTO_SYNC: z.string().default('true'),
  CRON_SECRET: z.string().min(16).optional(),

  // --- Customer sessions -------------------------------------------------------------------------
  // Signed with the same JWT_SECRET as owner sessions, but distinguished by per-realm
  // `iss`/`aud` claims (see src/shared/auth/revocation.ts) plus a separate cookie name,
  // so a token minted for one realm can never be replayed in the other.
  CUSTOMER_SESSION_TTL_HOURS: z.coerce.number().positive().default(24 * 7),

  // --- Email (password reset) ---------------------------------------------------------------------
  // All optional. Without them, reset emails are not sent: the reset link is logged to the server
  // console and, outside production, also returned in the API response so the flow stays testable.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z.coerce.boolean().default(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().default('"Your Store" <no-reply@yourstore.example>'),

  // --- Cloudinary (image CDN) -----------------------------------------------------------------------
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),

  // --- Payments ------------------------------------------------------------------------------------
  // Every payment method requires a real gateway; without one configured, checkout rejects those
  // methods with the exact env vars needed to enable them, rather than ever faking a "paid" result.
  // There is no cash on delivery: all orders are prepaid. Razorpay is the only supported gateway —
  // Stripe was config-only (no SDK, client, or webhook code) and has been removed from the enum.
  PAYMENT_GATEWAY: z.enum(['none', 'razorpay']).default('none'),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  // Separate secret configured in Razorpay Dashboard → Webhooks → Secret. NOT the API key secret.
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),

  // --- Bank-account encryption --------------------------------------------------------------------
  // Optional. BANK_ACCOUNT_KEY must be 64 hex chars (32 bytes) when set; otherwise the key is
  // derived from APP_SECRET, else from JWT_SECRET (which is always set — see the schema above).
  // There is deliberately no hardcoded fallback: without a real secret the process cannot start
  // with bank data encrypted under a publicly-known key.
  BANK_ACCOUNT_KEY: z.string().optional(),
  APP_SECRET: z.string().optional(),

  // --- Firebase Admin (push notifications) -------------------------------------------------------
  // All three are required to send push. Without them, push is skipped and the inbox still works.
  FIREBASE_PROJECT_ID: z.string().optional(),
  FIREBASE_CLIENT_EMAIL: z.string().optional(),
  FIREBASE_PRIVATE_KEY: z.string().optional(),

  // --- Store Wallet -------------------------------------------------------------------------------
  // Top-up is disabled in production by default until the merchant confirms provider support.
  // Set WALLET_TOPUP_ENABLED=true to enable. Amounts in USD cents.
  WALLET_TOPUP_ENABLED: z.string().default('false'),
  WALLET_TOPUP_MIN_CENTS: z.coerce.number().int().positive().default(500),    // $5.00
  WALLET_TOPUP_MAX_CENTS: z.coerce.number().int().positive().default(100000), // $1000.00
}).superRefine((data, ctx) => {
  // H10: in production the owner password must be explicitly set — the dev default must never
  // become a production back door. (The default still applies in dev/test so local setups keep
  // working; the seed uses the same default there.)
  if (data.NODE_ENV === 'production' && !process.env.OWNER_PASSWORD) {
    ctx.addIssue({
      code: 'custom',
      path: ['OWNER_PASSWORD'],
      message: 'OWNER_PASSWORD must be set explicitly in production (no default password is allowed).',
    });
  }
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  console.error(`\nInvalid backend environment:\n${details}\n\nCopy .env.example to .env and fill it in.\n`);
  process.exit(1);
}

// H11: bank-account data is encrypted under the JWT secret when neither a dedicated key nor an
// app secret is configured. That is safe (JWT_SECRET is required and secret) but worth knowing:
// set BANK_ACCOUNT_KEY or APP_SECRET to give bank data its own key.
if (!parsed.data.BANK_ACCOUNT_KEY && !parsed.data.APP_SECRET) {
  console.warn('[env] WARNING: BANK_ACCOUNT_KEY and APP_SECRET are both unset — bank-account data is encrypted under JWT_SECRET. Set BANK_ACCOUNT_KEY (64 hex chars) or APP_SECRET in backend/.env to use a dedicated key.');
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

export const isCloudinaryConfigured = Boolean(
  env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET,
);

export const isSmtpConfigured = Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASSWORD);

export const isFirebaseConfigured = Boolean(
  env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY,
);

export const isWalletTopupEnabled = env.WALLET_TOPUP_ENABLED === 'true';

export const isPaymentGatewayConfigured =
  env.PAYMENT_GATEWAY === 'razorpay' ? Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET) : false;

/** Exact env vars an operator needs to set to enable a real (online, prepaid) payment method. */
export const paymentGatewaySetupHelp =
  'Set PAYMENT_GATEWAY=razorpay with RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in backend/.env.';
