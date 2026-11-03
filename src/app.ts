import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { attachOwner } from './auth.js';
import { requireCsrf } from './csrf.js';
import { attachCustomer } from './customerAuth.js';
import { assertDatabaseReachable } from './db.js';
import { env } from './env.js';
import { errorHandler, notFound, route } from './http.js';
import { publicApiLimiter } from './rateLimit.js';
import { adminRouter } from './routes/admin.js';
import { contentRouter, publicContentRouter } from './routes/content.js';
import { adminCustomersRouter } from './routes/adminCustomers.js';
import { adminDashboardRouter } from './routes/adminDashboard.js';
import { adminOrdersRouter } from './routes/adminOrders.js';
import { checkoutRouter, orderTrackRouter } from './routes/checkout.js';
import { collectionsRouter, publicCollectionsRouter } from './routes/collections.js';
import { couponsRouter } from './routes/coupons.js';
import { navLinksRouter, publicNavLinksRouter } from './routes/nav.js';
import { customerAuthRouter, customerRouter } from './routes/customers.js';
import { inventoryRouter } from './routes/inventory.js';
import { adminMediaRouter, mediaRouter } from './routes/media.js';
import { publicRouter } from './routes/public.js';
import { adminReviewsRouter, customerReviewsRouter, publicReviewsRouter } from './routes/reviews.js';
import { adminReturnsRouter } from './routes/adminReturns.js';
import { importExportRouter } from './routes/importExport.js';
import { customerCancelRouter, customerReturnsRouter } from './routes/returns.js';
import { translationsRouter } from './routes/translations.js';
import { uiI18nAdminRouter, uiI18nPublicRouter } from './routes/uiI18n.js';
import { stripHindiResponses, translateResponses } from './translations.js';
import { publicSettingsRouter, settingsRouter } from './routes/settings.js';

export function createApp() {
  const app = express();

  // Only meaningful when actually deployed behind a reverse proxy/load balancer — see the TRUST_PROXY
  // comment in env.ts. Must be set deliberately: trusting X-Forwarded-For with no real proxy in front
  // lets any client spoof their apparent IP and dodge the per-IP rate limiters below.
  app.set('trust proxy', env.trustProxy);

  app.use(
    helmet({
      // This is a JSON API (plus raw image bytes under /media), never HTML — a content-security-policy
      // response header has no script/style surface to protect here, and a default-source policy would
      // be actively wrong for the many data: and cross-origin image loads the storefront/admin do.
      contentSecurityPolicy: false,
      // The storefront and admin run on different ports than this API and load product/media images
      // and fetch JSON cross-origin. Helmet's default ('same-origin') would make browsers that enforce
      // Cross-Origin-Resource-Policy block exactly that. CORS (below) already governs which origins may
      // read responses via fetch/XHR; this only affects the separate no-cors path (`<img src>` etc.).
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      // HSTS only makes sense once this is actually served over HTTPS (true in production; local dev is
      // plain http://localhost, where the header would be inert at best and confusing at worst).
      hsts: env.isProd,
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );

  app.use(
    cors({
      origin(origin, cb) {
        // Same-origin/curl requests have no Origin header; browsers always send one.
        if (!origin || env.corsOrigins.includes(origin)) return cb(null, true);
        cb(new Error(`Origin ${origin} is not allowed. Add it to CORS_ORIGINS.`));
      },
      credentials: true,
    }),
  );
  // Image uploads arrive as base64 JSON, so allow a larger body than the default 100kb.
  app.use(express.json({ limit: '12mb' }));
  app.use(cookieParser());
  app.use(attachOwner);
  app.use(attachCustomer);
  // After attachOwner/attachCustomer (needs req.owner/req.customer) and before every router.
  app.use(requireCsrf);
  app.use('/api', publicApiLimiter);
  app.use(stripHindiResponses);
  app.use(translateResponses);

  app.get(
    '/health',
    route(async (_req, res) => {
      await assertDatabaseReachable();
      res.json({ ok: true, service: 'your-store-backend', env: env.NODE_ENV, time: new Date().toISOString() });
    }),
  );

  app.use('/media', mediaRouter);
  app.use('/api/admin/media', adminMediaRouter);
  app.use('/api/admin/settings', settingsRouter);
  app.use('/api/admin/inventory', inventoryRouter);
  app.use('/api/admin/content', contentRouter);
  app.use('/api/admin/coupons', couponsRouter);
  app.use('/api/admin/orders', adminOrdersRouter);
  app.use('/api/admin/customers', adminCustomersRouter);
  app.use('/api/admin/dashboard', adminDashboardRouter);
  app.use('/api/admin/nav-links', navLinksRouter);
  app.use('/api/admin/collections', collectionsRouter);
  app.use('/api/admin/reviews', adminReviewsRouter);
  app.use('/api/admin/returns', adminReturnsRouter);
  app.use('/api/admin/translations', translationsRouter);
  app.use('/api/admin/i18n', uiI18nAdminRouter);
  app.use('/api/admin', importExportRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/settings', publicSettingsRouter);
  app.use('/api/content', publicContentRouter);
  app.use('/api/customer/auth', customerAuthRouter);
  app.use('/api/customer/reviews', customerReviewsRouter);
  app.use('/api/customer/returns', customerReturnsRouter);
  app.use('/api/customer/orders', customerCancelRouter);
  app.use('/api/customer', customerRouter);
  app.use('/api/checkout', checkoutRouter);
  app.use('/api/orders', orderTrackRouter);
  app.use('/api/i18n', uiI18nPublicRouter);
  app.use('/api/nav-links', publicNavLinksRouter);
  app.use('/api/collections', publicCollectionsRouter);
  app.use('/api', publicReviewsRouter);
  app.use('/api', publicRouter);

  app.use((_req, _res, next) => next(notFound('No such endpoint.')));
  app.use(errorHandler);

  return app;
}
