# Backend — what's built

Node + Express + TypeScript + Prisma (MySQL/MariaDB, XAMPP-compatible). Single-seller store API.

## Stack
Express 4, Prisma ORM, bcryptjs, jsonwebtoken, cookie-parser, cors, zod, tsx (dev), vitest, nodemailer (optional SMTP).

## Database
`prisma/schema.prisma`. Portable design: list-ish fields stored as JSON text (not native arrays), search via a precomputed lowercase `searchText` column (not engine-specific ILIKE/FULLTEXT) — same schema runs on MySQL/Postgres/SQLite.

Models: `Owner`, `Media`, `Category`, `Product`/`ProductImage`/`ProductOption`/`ProductOptionValue`/`ProductVariant`/`ProductSpec`, `StoreSettings`, `ShippingSettings`/`ShippingZone`, `TaxSettings`/`TaxRule`, `CurrencySettings`/`CurrencyConfig`, `LanguageSettings`, `InventoryAdjustment`, `HomepageContent`, `PageDoc`, `Coupon`/`CouponRedemption`, `Customer`/`CustomerAddress`/`WishlistItem`/`PasswordResetToken`, `Order`/`OrderLine`/`OrderEvent`/`OrderNote`, `NavLink`, `Collection`/`CollectionCircle`/`CollectionSection`.

Seed: `prisma/seed.ts` — idempotent, re-runnable without duplicating or clobbering admin edits. Always seeds: the owner account (only if none exists yet with that email — never overwrites an existing owner's password/name), store/shipping/tax/currency/language settings, and the 7 info/policy pages (published, generic placeholder copy). The demo customer and the sample catalog (4 categories, 20 products/46 variants, homepage demo content, 4 nav links, 2 example collections) are each off by default — opt in with `SEED_DEMO_CUSTOMER=1` / `SEED_SAMPLE_CATALOG=1` in `.env` before running `npm run db:seed`, so a routine seed on a real store never creates demo/sample data.

## Auth
Two independent sessions, both signed JWT in httpOnly cookies:
- **Owner**: `src/auth.ts`, cookie `ys_owner_session`, middleware `requireOwner`.
- **Customer**: `src/customerAuth.ts`, cookie `ys_customer_session`, middleware `requireCustomer`, `attachCustomer` (non-blocking, used on public routes that behave differently when signed in).

## Endpoints

### Public (no auth)
| Path | Purpose |
|---|---|
| `GET /health` | Liveness + DB check |
| `GET /api/categories`, `/api/products`, `/api/products/:slug` | Catalog — active products in active categories only |
| `GET /media/:id` | Durable image bytes |
| `GET /api/settings` | Store identity/contact, enabled currencies, languages, shipping zone rates |
| `GET /api/content/homepage`, `/api/content/pages/:key` | Published content, `{published:false,content:null}` if nothing published |
| `GET /api/nav-links` | Active secondary-nav links |
| `GET /api/collections` | Published collections with cover image and `showInNavigation` flag, ordered by display order |
| `GET /api/collections/:slug` | Published collection, products resolved per section |
| `POST /api/customer/auth/{register,login,logout}`, `GET /auth/me`, `POST /auth/password-reset/{request,confirm}` | Customer auth |
| `POST /api/checkout/{totals,validate-coupon,orders}` | Server-calculated preview/coupon-check/order placement |
| `GET /api/orders/:id` | Order by its own (unguessable) id — confirmation-page lookup |
| `GET /api/orders/track?number=&email=` | Order by number + email (both required — number alone is guessable) |

### Customer (requires `ys_customer_session`)
`GET/PUT /api/customer/profile`, `GET/PUT/DELETE /api/customer/addresses[...]`, `GET/POST/DELETE /api/customer/wishlist[...]`, `GET /api/customer/orders[...]`.

### Owner (requires `ys_owner_session`)
Products/Categories/Media: `/api/admin/products...`, `/api/admin/categories...`, `/api/admin/media...` — atomic product+variant writes, server-side slug/SKU/price validation.
Inventory: `/api/admin/inventory` (list, `/adjust` with concurrency-safe conditional stock update, `/history`).
Settings: `/api/admin/settings/{store,shipping,tax,currencies,languages}`.
Content: `/api/admin/content/homepage`, `/api/admin/content/pages/:key` (draft/publish/discard lifecycle).
Coupons: `/api/admin/coupons...` (+ `/uses` usage lookup).
Orders: `/api/admin/orders...` (`/advance`, `/tracking`, `/cancel`, `/refund`, `/mark-paid`, `/notes`) — fulfilment/payment state machine enforced server-side.
Customers (read-only, derived): `/api/admin/customers...`.
Dashboard: `/api/admin/dashboard?from=&to=` — computed live from real orders, no stored metrics table.
Navigation: `/api/admin/nav-links...` (+ `/reorder`).
Collections: `/api/admin/collections...` (+ `/:id/status` publish/unpublish); each collection can be independently included in storefront navigation.

Error shape everywhere: `{ error: { code, message, issues: [{path,message}] } }`.

## Pricing engine (`src/pricing.ts`)
Shared by checkout preview and order placement — same pipeline, so a preview and its order can never disagree. Money in USD minor units; converted to the customer's currency via a rate snapshot captured at order time and stored (so historical orders never drift if rates change later). Handles shipping-zone lookup, tax-rate lookup (country/region rule, fallback to store default), coupon evaluation (percentage/fixed, scope, min order, per-customer limit).

## Concurrency safety
Stock decrement and coupon usage both use conditional `updateMany` (`WHERE stock >= qty` / `WHERE timesUsed < usageLimit`) inside a transaction — verified under real parallel load (12 concurrent orders against stock=5 → exactly 5 succeed, stock never negative).

## Payments
Only **cash on delivery** is real. Card/UPI/wallet are modelled (schema, validation, admin UI) but rejected at checkout with a clear message — no gateway is configured. To enable a real gateway: set `PAYMENT_GATEWAY=razorpay` + `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET`, or `PAYMENT_GATEWAY=stripe` + `STRIPE_SECRET_KEY`, in `.env` (the actual provider integration code still needs writing — the env plumbing and the "reject until configured" guard exist today).

## Email
No SMTP configured by default. Password-reset emails fall back to a console-logged dev preview (`src/mailer.ts`) so the flow is testable without a real provider. To enable real delivery: set `SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD` in `.env`.

## Not built
Real payment gateway integration, subcategories (flat 4-category taxonomy).

## Reviews
`Review` + `ReviewModerationEvent` tables (migrations `add_reviews`, `review_edited_at`). One review per customer per product (unique index). Eligibility: a delivered account order of that customer containing the product, checked server-side; the qualifying order is recorded. Public: `GET /api/products/:slug/reviews?page=&pageSize=&sort=newest|highest|lowest&rating=` (published only, display name only). Customer: `GET /api/customer/reviews`, `GET /api/customer/reviews/product/:productId`, `POST /api/customer/reviews`, `PUT|DELETE /api/customer/reviews/:id` (rate limited, CSRF). Owner: `GET /api/admin/reviews` (q, productId, status, rating, from, to, sort, page), `POST /api/admin/reviews/:id/hide|restore` with required reason. Product `rating`/`reviewCount`/`reviewDistribution` are live DB aggregates over published reviews. Tests: `src/routes/__tests__/reviews.test.ts`.

## Scripts
`npm run dev|build|start|typecheck|test`, `prisma:generate`, `db:{migrate,deploy,reset,seed,studio,create,password}`, `check:env`, `setup` (generate + migrate + seed).

## Content translations
`ContentTranslation` table (migration `content_translations`): translation memory keyed by sha256 of the exact English text, per language (`de`, `fr`, `it`, `es`). Middleware `translateResponses` (`src/translations.ts`): on GET requests with header `x-lang: de|fr|it|es`, every Localized `{ en, … }` object in the JSON response gets a `[lang]` value when a translation exists — products, categories, homepage, pages, nav links, collections, settings, reviews' product names. Edited English text no longer matches, so it shows in English until re-translated (never a stale translation). Owner API: `GET /api/admin/translations?lang=&status=all|missing|translated&q=&page=` (sources discovered live from current content, with where each is used), `PUT /api/admin/translations { source, lang, text }` (empty text removes). Tests: `src/routes/__tests__/translations.test.ts`.
