# Your Store — API (`backend/`)

Express + TypeScript + MySQL (Prisma) API for the shop: public catalog, checkout
(Razorpay), orders, customers, wallet, coupons, content, settings, newsletter,
reviews, returns/exchanges, and the owner admin API. Cash on delivery is not
offered — all orders are prepaid.

## What it gives you

- **Owner authentication.** One owner account, bcrypt-hashed password, session in a signed **httpOnly**
  cookie. Every admin write is rejected without a valid session.
- **Public catalog.** `/api/products` and `/api/products/:slug` return **only `active` products in
  `isActive` categories**. Draft and archived products 404 even on a direct URL, so an unpublished
  product is never reachable by guessing its slug. The list is server-paginated (default 24 per
  page) and searchable through a MySQL full-text index on the product search haystack.
- **Real checkout.** Server-calculated totals, Razorpay orders, signature verification, atomic
  order placement (stock, coupon, wallet debit in one transaction), and an order webhook that
  records paid-but-no-order payments for recovery. Refunds go through Razorpay for card/UPI
  payments and back to the wallet for wallet payments.
- **Server-side validation.** Unique slugs and catalogue-wide unique SKUs, no negative prices or stock,
  sale price below price, variants matching their options, and stricter rules to publish (image +
  descriptions + price above zero). The apps validate too, but these rules are the authoritative ones.
- **Atomic writes.** A product and all of its options, values, variants, images and specs are written
  in one transaction: a failure part-way cannot leave a half-saved product.
- **Images on Cloudinary.** Product and media images are uploaded to Cloudinary when configured
  (`CLOUDINARY_*` in `.env`) and served from there; without Cloudinary, image bytes live in the
  database and are served from `/media/:id`.

## Requirements

- Node.js 18+ (tested on 24)
- A MySQL/MariaDB server. **XAMPP works out of the box** — just start MySQL from the XAMPP
  Control Panel; its default `root` account has no password, so no setup is needed on the DB side.
  MySQL is the only supported database: the schema uses MySQL-only constructs (`FULLTEXT`,
  `NOW(3)`, `JSON_EXTRACT`), so it does not run on PostgreSQL or SQLite.

## Setup

From the `backend/` folder — works in cmd.exe, PowerShell and Git Bash:

```
npm install
```

Create `backend/.env` with the variables in `src/shared/config/env.ts` (`DATABASE_URL`,
`JWT_SECRET`, `OWNER_EMAIL` / `OWNER_PASSWORD`, Razorpay and Cloudinary keys), then:

```
npm run db:create           creates the yourstore_dev database (utf8mb4, needed for Hindi text)
npm run setup                applies migrations, seeds the catalog
npm run dev                  http://localhost:4000
```

`npm run db:create` and `npm run setup` are both safe to re-run — neither drops existing data. Check
the API is alive:

```
curl http://localhost:4000/health
curl http://localhost:4000/api/products
```

`npm run check:env` reports exactly what is wrong if `DATABASE_URL` is missing or malformed; `setup`
and `dev` run it first so you get an actionable message instead of a raw driver error.

### Using a MySQL server other than XAMPP

If `root` has a password, or you're connecting to a different host/user, run `npm run db:password` to
rewrite `DATABASE_URL` interactively (it percent-encodes the password for you), or edit
`backend/.env` directly: `mysql://user:password@host:3306/database`.

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start with reload on change (tsx watch) |
| `npm run build` / `npm start` | Compile to `dist/` and run the compiled server |
| `npm run typecheck` | TypeScript, no emit |
| `npm run lint` | ESLint (flat config, `eslint.config.mjs`) |
| `npm run test` | Vitest. Pure unit tests run anywhere; integration tests need the dev MySQL database from `.env` |
| `npm run db:migrate` | Create a new migration from schema changes (development) |
| `npm run db:deploy` | Apply existing migrations (safe for a fresh database or CI) |
| `npm run db:seed` | Idempotent seed; `SEED_FORCE=1` overwrites existing products |
| `npm run db:reset` | **Drops and recreates** the schema, then re-seeds |
| `npm run db:studio` | Prisma Studio, a browser UI over the tables |

### Seed

The seed is **idempotent**: re-running never duplicates rows, and products that already exist are
left untouched so edits made in the admin survive a re-seed (use `SEED_FORCE=1` to overwrite).

It loads the owner account, the four categories and the 20 sample products with the **same ids, slugs,
SKUs, USD prices, stock levels and English/Hindi copy** both apps already shipped, so nothing in the
UI shifts when you switch to API mode.

## Environment

See `src/shared/config/env.ts` for the full variable list. `DATABASE_URL` must point at a
**development** database — `npm run db:reset` drops the schema. `JWT_SECRET` signs session cookies;
set your own. `OWNER_EMAIL` / `OWNER_PASSWORD` seed the single owner account and should be changed
before this API is exposed anywhere. In production `OWNER_PASSWORD` must be set explicitly (the dev
default is refused at startup).

## Endpoints

### Public (no authentication)

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness + database and schema check |
| GET | `/api/categories` | Active categories, ordered |
| GET | `/api/products` | Active products in active categories. `?q=`, `?category=slug,slug`, `?ids=a,b`, `?page=`, `?limit=` (default 24, max 200) |
| GET | `/api/products/:slug` | One active product; 404 for draft/archived |
| GET | `/media/:id` | Image bytes. Public only while referenced by published content (active product/category, store logo, published collection or homepage); otherwise 404 unless the owner is signed in |
| GET | `/api/orders/track` | `?number=&email=` (rate limited). Trimmed view: status, timeline, lines, totals — no address, phone or email |
| GET | `/api/orders/:id` | Full order (rate limited, `Cache-Control: no-store`). Account order: signed-in owner of that order only. Guest order: `X-Order-Token` header with the one-time token returned by checkout. Anything else: 404 |
| POST | `/api/checkout/totals` | Server-calculated preview (shipping, tax, coupon) |
| POST | `/api/checkout/razorpay/create-order` | Creates the Razorpay order for the previewed total |
| POST | `/api/checkout/orders` | Places the order (verifies the Razorpay payment) |
| POST | `/api/newsletter` | Newsletter sign-up |
| POST | `/api/contact` | Contact form |
| GET | `/api/i18n/:lng/translation` | Storefront UI strings for one language |

### Owner session

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/admin/auth/login` | `{ email, password }` → sets the session cookie |
| POST | `/api/admin/auth/logout` | Clears the cookie |
| GET | `/api/admin/auth/me` | Current owner, or 401 |
| POST | `/api/admin/auth/forgot-password` | Owner password reset (emailed link, 1 h token) |
| POST | `/api/admin/auth/reset-password` | Completes the reset |

### Owner only (401 without a valid session)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/admin/products` | All products, any status. `?q=`, `?status=`, `?page=`, `?pageSize=` (server-paginated) |
| GET | `/api/admin/products/:id` | One product, any status |
| POST | `/api/admin/products` | Create (atomic) |
| PUT | `/api/admin/products/:id` | Replace (atomic) |
| PATCH | `/api/admin/products/:id/status` | Publish / unpublish / archive, re-validating publish rules |
| GET | `/api/admin/categories` | Categories with product counts |
| POST/PUT | `/api/admin/categories[/:id]` | Create / update |
| GET | `/api/admin/media` | Image metadata (never the bytes) |
| POST | `/api/admin/media` | Upload `{ fileName, mimeType, base64, alt }` |
| GET | `/api/admin/orders` | Server-paginated orders. `?q=`, `?fulfilment=`, `?payment=`, `?page=`, `?pageSize=` |
| GET | `/api/admin/dashboard` | Live dashboard aggregates, `?from=&to=` |

Errors are always `{ "error": { "code", "message", "issues": [{ "path", "message" }] } }`, so the admin
can show messages next to the right field. Codes: `validation`, `unauthorized`, `forbidden` (missing/invalid
CSRF token), `not_found`, `conflict`, `rate_limited` (429, with `Retry-After` and `RateLimit-*` headers).

## Connecting the apps

Both apps switch to the API when `VITE_API_BASE_URL` is set, and there is **no silent fallback**: if the
backend is down they show an error rather than quietly serving sample data.

```
frontend/.env.local   VITE_API_BASE_URL=http://localhost:5173 -> set to http://localhost:4000
admin/.env.local      VITE_API_BASE_URL=http://localhost:4000
```

The admin sends cookies with every request, so its origin must appear in `CORS_ORIGINS`.

## Security notes

- Passwords are bcrypt-hashed; session cookies are httpOnly, signed and `SameSite=Lax`.
- **CSRF:** login also sets a readable `ys_csrf` cookie. Every POST/PUT/PATCH/DELETE from a signed-in owner
  or customer must echo it in an `X-CSRF-Token` header, or gets 403 (`src/shared/middleware/csrf.middleware.ts`). Both apps' API clients
  do this automatically. A session from before this was added has no CSRF cookie and must sign in again.
- **Rate limits** (`src/shared/middleware/rate-limit.middleware.ts`): login (per IP and, separately, per account), registration, password
  reset request (per IP and per account) and confirm, order lookup/tracking, coupon validation, plus a
  coarse limit on all of `/api`. Counters are **in memory**: correct for one backend process, but each
  extra instance behind a load balancer gets its own counters — use a shared store (e.g. Redis) first.
- **Proxy:** per-IP limits depend on `TRUST_PROXY` (see `src/shared/config/env.ts`). Leave it `false` unless a reverse
  proxy sits in front; set it to the exact hop count when one does. Wrong either way breaks per-IP limits.
- **Headers:** `helmet` sets nosniff, frame, referrer (`no-referrer`) and related headers; HSTS only when
  `NODE_ENV=production`. `Cross-Origin-Resource-Policy: cross-origin` so the apps can load `/media` images.
- **Orders:** an order id alone never returns an order. Guest checkout returns a one-time `accessToken`
  (stored only as a SHA-256 hash, valid 30 days) which the storefront keeps in `sessionStorage` and sends
  as `X-Order-Token` — never in a URL. Closing the tab loses it; `/track-order` remains the fallback.
- **Media:** unreferenced or draft-only uploads are not publicly fetchable. Owner previews rely on the
  owner cookie reaching `/media` from the admin's plain `<img>` tags, which works while the admin and API
  share a site (e.g. both on `localhost`, or `admin.example.com` + `api.example.com`). On different sites
  the admin would show broken previews for unpublished images.
- `secure` is only set on cookies in production, because browsers drop Secure cookies over plain
  `http://localhost`. Put this behind HTTPS before any real deployment and set `NODE_ENV=production`.
- Uploads are checked for declared type and size; add real content sniffing and virus scanning before
  accepting files from anyone but the owner. `/media` responses carry a sandboxing CSP, so an uploaded SVG
  opened directly cannot run script on the API origin.
