# Backend — what's built

Node + Express + TypeScript + Prisma (MySQL/MariaDB, XAMPP-compatible). Single-seller store API.

## Stack
Express 4, Prisma ORM, bcryptjs, jsonwebtoken, cookie-parser, cors, zod, tsx (dev), vitest, nodemailer (optional SMTP), compression, eslint (flat config).

## Database
`prisma/schema.prisma`. MySQL only — the schema uses MySQL-only constructs (`FULLTEXT` on
`Product.searchText`, `NOW(3)`, `JSON_EXTRACT` in raw queries), and list-ish fields are stored as
JSON text (not native arrays). Search uses a precomputed lowercase `searchText` column plus the
full-text index; `MATCH(searchText) AGAINST(? IN BOOLEAN MODE)` for queries of 4+ characters,
LIKE fallback for shorter ones.

Models: `Owner`, `Media`, `Category`, `Product`/`ProductImage`/`ProductOption`/`ProductOptionValue`/`ProductVariant`/`ProductSpec`, `StoreSettings`, `ShippingSettings`/`ShippingZone`, `TaxSettings`/`TaxRule`, `CurrencySettings`/`CurrencyConfig`, `LanguageSettings`, `InventoryAdjustment`, `HomepageContent`, `PageDoc`, `Coupon`/`CouponRedemption`, `Customer`/`CustomerAddress`/`WishlistItem`/`PasswordResetToken`, `Order`/`OrderLine`/`OrderEvent`/`OrderNote`, `NavLink`, `Collection`/`CollectionCircle`/`CollectionSection`, `Review`/`ReviewModerationEvent`, `ContentTranslation`, `ContactMessage`, `NewsletterSubscriber`, `FcmToken`, `NotificationRecord`/`NotificationSend`, `WalletBalance`/`WalletTransaction`/`WalletTopup`, `ReturnRequest`/`ReturnEvent`/`Refund`, `ExchangeRequest`/`ExchangeEvent`, `CustomerBankAccount`, `StockHold`, `RevokedSession`, `RazorpayOrder`.

Seed: `prisma/seed.ts` — idempotent, re-runnable without duplicating or clobbering admin edits. Always seeds: the owner account (only if none exists yet with that email — never overwrites an existing owner's password/name), store/shipping/tax/currency/language settings, and the 7 info/policy pages (published, generic placeholder copy). The demo customer and the sample catalog (4 categories, 20 products/46 variants, homepage demo content, 4 nav links, 2 example collections) are each off by default — opt in with `SEED_DEMO_CUSTOMER=1` / `SEED_SAMPLE_CATALOG=1` in `.env` before running `npm run db:seed`, so a routine seed on a real store never creates demo/sample data. The main currencies seed with live sync on (`autoRate: true` for INR/EUR/GBP); seed rates are starting values replaced by live sync.

## Auth
Two independent sessions, both signed JWT in httpOnly cookies:
- **Owner**: `src/modules/admin-auth/`, cookie `ys_owner_session`, middleware `requireOwner`.
- **Customer**: `src/modules/customers/customer-auth.*`, cookie `ys_customer_session`, middleware `requireCustomer`, `attachCustomer` (non-blocking, used on public routes that behave differently when signed in).
Both realms share one `JWT_SECRET` but are distinguished by `iss`/`aud` claims
(owner `iss='your-store-owner'`, customer `iss='your-store-customer'`, `aud='your-store'`
for both; tokens minted before the claims were added are still accepted during
transition) and by cookie name. Logout revokes the session server-side: the token's
`jti` is stored (hashed) in `RevokedSession` and checked by `requireOwner` /
`requireCustomer` on every request; password changes revoke the current token too.
Customer sessions last 7 days by default (`CUSTOMER_SESSION_TTL_HOURS`, env).

## Endpoints

### Public (no auth)
| Path | Purpose |
|---|---|
| `GET /health` | Liveness + DB and schema check |
| `GET /api/categories`, `/api/products`, `/api/products/:slug` | Catalog — active products in active categories only; list is server-paginated (default 24, max 200) with full-text search |
| `GET /media/:id` | Durable image bytes |
| `GET /api/settings` | Store identity/contact, enabled currencies, languages, shipping zone rates |
| `GET /api/content/homepage`, `/api/content/pages/:key` | Published content, `{published:false,content:null}` if nothing published |
| `GET /api/nav-links` | Active secondary-nav links |
| `GET /api/collections` | Published collections with cover image and `showInNavigation` flag, ordered by display order |
| `GET /api/collections/:slug` | Published collection, products resolved per section |
| `POST /api/customer/auth/{register,login,logout}`, `GET /auth/me`, `POST /auth/password-reset/{request,confirm}` | Customer auth |
| `POST /api/checkout/{totals,validate-coupon,orders}` | Server-calculated preview/coupon-check/order placement |
| `POST /api/checkout/razorpay/create-order` | Creates the Razorpay order for the previewed total |
| `POST /api/webhooks/orders/razorpay` | Razorpay order webhook (payment captured/failed, recovery records) |
| `GET /api/orders/:id` | Order by its own (unguessable) id — confirmation-page lookup |
| `GET /api/orders/track?number=&email=` | Order by number + email (both required — number alone is guessable) |
| `POST /api/newsletter`, `POST /api/contact` | Newsletter sign-up, contact form |
| `GET /api/i18n/:lng/translation` | Storefront UI strings for one language |

### Customer (requires `ys_customer_session`)
`GET/PUT /api/customer/profile`, `GET/PUT/DELETE /api/customer/addresses[...]`, `GET/POST/DELETE /api/customer/wishlist[...]`, `GET /api/customer/orders[...]`, wallet (`GET /api/customer/wallet`, top-up create/verify), bank accounts / UPI ids, returns and exchanges, notifications (list, unread count, push token).

### Owner (requires `ys_owner_session`)
Products/Categories/Media: `/api/admin/products...`, `/api/admin/categories...`, `/api/admin/media...` — atomic product+variant writes, server-side slug/SKU/price validation. Products list and export share one server-side filter parser; import (`POST /api/admin/products/import`, Excel) validates per row, converts INR→USD at the configured rate, and runs in one transaction.
Inventory: `/api/admin/inventory` (list, `/adjust` with concurrency-safe conditional stock update, `/history`).
Settings: `/api/admin/settings/{store,shipping,tax,currencies}` (+ `POST /currencies/refresh` for a live rate sync).
Content: `/api/admin/content/homepage`, `/api/admin/content/pages/:key` (draft/publish/discard lifecycle).
Coupons: `/api/admin/coupons...` (+ `/uses` usage lookup).
Orders: `/api/admin/orders...` (`/advance`, `/tracking`, `/cancel`, `/refund`, `/mark-paid`, `/notes`) — fulfilment/payment state machine enforced server-side. Payment recoveries: `/api/admin/payment-recoveries`.
Customers (read-only, derived): `/api/admin/customers...`.
Dashboard: `/api/admin/dashboard?from=&to=` — computed live from real orders with database aggregates, no stored metrics table.
Navigation: `/api/admin/nav-links...` (+ `/reorder`).
Collections: `/api/admin/collections...` (+ `/:id/status` publish/unpublish); each collection can be independently included in storefront navigation.
Returns/exchanges: `/api/admin/returns...`, `/api/admin/exchanges...` (approve/reject/pickup/receive/inspect, refunds).
Notifications: `/api/admin/notifications...` (inbox, unread count, send, push flush).

Error shape everywhere: `{ error: { code, message, issues: [{path,message}] } }`.

## Pricing engine (`src/modules/checkout/pricing.service.ts`)
Shared by checkout preview and order placement — same pipeline, so a preview and its order can never disagree. Money in USD minor units; converted to the customer's currency via a rate snapshot captured at order time and stored (so historical orders never drift if rates change later). Handles shipping-zone lookup, tax-rate lookup (country/region rule, fallback to store default), coupon evaluation (percentage/fixed, scope, min order, per-customer limit). All rounding goes through `roundMinor` (`src/shared/utils/currency.ts`) with the currency's rounding increment.

## Concurrency safety
Stock decrement and coupon usage both use conditional `updateMany` (`WHERE stock >= qty` / `WHERE timesUsed < usageLimit`) inside a transaction. Stock holds (`StockHold`, expiring) reserve units while the shopper is in the Razorpay modal.

## Payments
Real Razorpay integration — card/UPI via Razorpay Checkout, wallet (full and split: wallet covers part, Razorpay charges the remainder), and wallet top-up. There is **no cash on delivery**: `'cod'` is rejected by validation, and all orders are prepaid. Razorpay order/payment ids are persisted on the order (`razorpayOrderId`, `paymentReference`, unique on the payment id), so one gateway payment can fund at most one order. Refunds are real: `original` refunds call Razorpay `payments.refund` and complete only on gateway success; wallet-paid amounts are credited back to the wallet; manual bank/UPI refunds are completed through the verify endpoint. Stripe is not supported (it was config-only and has been removed from the gateway enum). To enable Razorpay: set `PAYMENT_GATEWAY=razorpay` + `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET`, plus `RAZORPAY_WEBHOOK_SECRET` for the order webhook, in `.env`.

## Email
No SMTP configured by default. Password-reset emails fall back to a console-logged dev preview (`src/shared/mail/mailer.ts`) so the flow is testable without a real provider. To enable real delivery: set `SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD` in `.env`.

## Notifications
Inbox + push via Firebase Cloud Messaging. The event handler is registered inside `createApp()` (`src/app.ts`), so it works on Vercel as well as on a long-running server; the push-flush cron runs on Vercel Cron. Without the Firebase vars, push is skipped and the inbox still works.

## Caching
Public catalogue/content GETs carry `Cache-Control: public, s-maxage=30, stale-while-revalidate=60` for Vercel's edge (the currency cron path is excluded). Responses are gzipped above 1 KB (`compression`). There is no edge purge on product/settings save — that needs a Vercel API token the project does not have, so edits age out within the cache window. Translation rows are cached per instance for 60 s.

## Not built
Subcategories (flat 4-category taxonomy).

## Reviews
`Review` + `ReviewModerationEvent` tables. One review per customer per product (unique index). Eligibility: a delivered account order of that customer containing the product, checked server-side; the qualifying order is recorded. Public: `GET /api/products/:slug/reviews?page=&pageSize=&sort=newest|highest|lowest&rating=` (published only, display name only). Customer: `GET /api/customer/reviews`, `GET /api/customer/reviews/product/:productId`, `POST /api/customer/reviews`, `PUT|DELETE /api/customer/reviews/:id` (rate limited, CSRF). Owner: `GET /api/admin/reviews` (q, productId, status, rating, from, to, sort, page), `POST /api/admin/reviews/:id/hide|restore` with required reason. Product `rating`/`reviewCount`/`reviewDistribution` are live DB aggregates over published reviews.

## Scripts
`npm run dev|build|start|typecheck|lint|test`, `prisma:generate`, `db:{migrate,deploy,reset,seed,studio,create,password}`, `check:env`, `setup` (generate + migrate + seed).

## Content translations
`ContentTranslation` table: translation memory keyed by sha256 of the exact English text, per language (`de`, `fr`, `it`, `es`). Middleware `translateResponses` (`src/modules/translations/translation.middleware.ts`): on public GET requests with header `x-lang: de|fr|it|es`, every Localized `{ en, … }` object in the JSON response gets a `[lang]` value when a translation exists — products, categories, homepage, pages, nav links, collections, settings, reviews' product names. Edited English text no longer matches, so it shows in English until re-translated (never a stale translation). Owner API: `GET /api/admin/translations?lang=&status=all|missing|translated&q=&page=` (sources discovered live from current content, with where each is used), `PUT /api/admin/translations { source, lang, text }` (empty text removes).
