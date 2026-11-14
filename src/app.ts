import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { attachOwner, requireOwner } from './shared/middleware/auth.middleware.js';
import { requireCsrf } from './shared/middleware/csrf.middleware.js';
import { attachCustomer } from './shared/middleware/customer-auth.middleware.js';
import { assertDatabaseReachable } from './shared/database/prisma.js';
import { env } from './shared/config/env.js';
import { errorHandler } from './shared/http/error-handler.js';
import { notFound } from './shared/errors/http-error.js';
import { route } from './shared/http/async-route.js';
import { publicApiLimiter } from './shared/middleware/rate-limit.middleware.js';
import { adminAuthRouter } from './modules/admin-auth/admin-auth.routes.js';
import { categoryRouter } from './modules/categories/category.routes.js';
import { productRouter } from './modules/products/product.routes.js';
import { contentRouter } from './modules/content/admin-content.routes.js';
import { publicContentRouter } from './modules/content/content.routes.js';
import { adminCustomersRouter } from './modules/customers/admin-customer.routes.js';
import { adminDashboardRouter } from './modules/dashboard/dashboard.routes.js';
import { adminOrdersRouter } from './modules/orders/admin-order.routes.js';
import { checkoutRouter } from './modules/checkout/checkout.routes.js';
import { orderTrackRouter } from './modules/orders/order.routes.js';
import { collectionsRouter } from './modules/collections/admin-collection.routes.js';
import { publicCollectionsRouter } from './modules/collections/collection.routes.js';
import { couponsRouter } from './modules/coupons/coupon.routes.js';
import { navLinksRouter } from './modules/navigation/admin-nav.routes.js';
import { publicNavLinksRouter } from './modules/navigation/nav.routes.js';
import { itemGroupsRouter } from './modules/item-groups/admin-item-group.routes.js';
import { publicItemGroupsRouter } from './modules/item-groups/item-group.routes.js';
import { customerAuthRouter } from './modules/customers/customer-auth.routes.js';
import { customerRouter } from './modules/customers/customer.routes.js';
import { inventoryRouter } from './modules/inventory/inventory.routes.js';
import { adminMediaRouter } from './modules/media/admin-media.routes.js';
import { mediaRouter } from './modules/media/media.routes.js';
import { storefrontCategoryRouter } from './modules/categories/storefront-category.routes.js';
import { storefrontProductRouter } from './modules/products/storefront-product.routes.js';
import { contactRouter } from './modules/contacts/contact.routes.js';
import { publicReviewsRouter } from './modules/reviews/review.routes.js';
import { customerReviewsRouter } from './modules/reviews/customer-review.routes.js';
import { adminReviewsRouter } from './modules/reviews/admin-review.routes.js';
import { adminReturnsRouter } from './modules/returns/admin-return.routes.js';
import { adminContactsRouter } from './modules/contacts/admin-contact.routes.js';
import { adminHelpRouter } from './modules/help/admin-help.routes.js';
import { publicHelpRouter } from './modules/help/help.routes.js';
import { importExportRouter } from './modules/import-export/import-export.routes.js';
import { customerCancelRouter } from './modules/returns/customer-cancel.routes.js';
import { customerReturnsRouter } from './modules/returns/customer-return.routes.js';
import { customerExchangesRouter } from './modules/exchanges/customer-exchange.routes.js';
import { customerBankAccountsRouter } from './modules/bank-accounts/bank-account.routes.js';
import { customerUpiRouter } from './modules/bank-accounts/upi.routes.js';
import { adminExchangesRouter } from './modules/exchanges/admin-exchange.routes.js';
import { translationsRouter } from './modules/translations/translation.routes.js';
import { uiI18nAdminRouter } from './modules/ui-i18n/admin-ui-i18n.routes.js';
import { uiI18nPublicRouter } from './modules/ui-i18n/ui-i18n.routes.js';
import { stripHindiResponses, translateResponses } from './modules/translations/translation.middleware.js';
import { settingsRouter } from './modules/settings/admin-settings.routes.js';
import { publicSettingsRouter } from './modules/settings/settings.routes.js';

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
  // Owner login/logout/me must be mounted before the owner gate below. In particular, importExportRouter
  // installs requireOwner at router level and would otherwise reject /auth/login.
  app.use('/api/admin/auth', adminAuthRouter);
  // Everything under /api/admin from here on requires a valid owner session — including paths no router
  // below handles (those answer 401, not 404, to anonymous callers).
  app.use('/api/admin', requireOwner);
  app.use('/api/admin/categories', categoryRouter);
  app.use('/api/admin/products', productRouter);
  app.use('/api/admin/media', adminMediaRouter);
  app.use('/api/admin/settings', settingsRouter);
  app.use('/api/admin/inventory', inventoryRouter);
  app.use('/api/admin/content', contentRouter);
  app.use('/api/admin/coupons', couponsRouter);
  app.use('/api/admin/orders', adminOrdersRouter);
  app.use('/api/admin/customers', adminCustomersRouter);
  app.use('/api/admin/dashboard', adminDashboardRouter);
  app.use('/api/admin/nav-links', navLinksRouter);
  app.use('/api/admin/item-groups', itemGroupsRouter);
  app.use('/api/admin/collections', collectionsRouter);
  app.use('/api/admin/reviews', adminReviewsRouter);
  app.use('/api/admin/returns', adminReturnsRouter);
  app.use('/api/admin/exchanges', adminExchangesRouter);
  app.use('/api/admin/contacts', adminContactsRouter);
  app.use('/api/admin/help', adminHelpRouter);
  app.use('/api/help', publicHelpRouter);
  app.use('/api/admin/translations', translationsRouter);
  app.use('/api/admin/i18n', uiI18nAdminRouter);
  app.use('/api/admin', importExportRouter);
  app.use('/api/settings', publicSettingsRouter);
  app.use('/api/content', publicContentRouter);
  app.use('/api/customer/auth', customerAuthRouter);
  app.use('/api/customer/reviews', customerReviewsRouter);
  app.use('/api/customer/returns', customerReturnsRouter);
  app.use('/api/customer/exchanges', customerExchangesRouter);
  app.use('/api/customer/bank-accounts', customerBankAccountsRouter);
  app.use('/api/customer/upi-ids', customerUpiRouter);
  app.use('/api/customer/orders', customerCancelRouter);
  app.use('/api/customer', customerRouter);
  app.use('/api/checkout', checkoutRouter);
  app.use('/api/orders', orderTrackRouter);
  app.use('/api/i18n', uiI18nPublicRouter);
  app.use('/api/nav-links', publicNavLinksRouter);
  app.use('/api/item-groups', publicItemGroupsRouter);
  app.use('/api/collections', publicCollectionsRouter);
  app.use('/api', publicReviewsRouter);
  app.use('/api', storefrontCategoryRouter);
  app.use('/api', storefrontProductRouter);
  app.use('/api', contactRouter);

  app.use((_req, _res, next) => next(notFound('No such endpoint.')));
  app.use(errorHandler);

  return app;
}
