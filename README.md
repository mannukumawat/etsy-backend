# Your Store — API (`backend/`)

Express + TypeScript + MySQL (Prisma) API for the shop's **catalog**: owner authentication,
categories, products (options, variants, images, specs) and media.

This is milestone 1. Checkout, orders, customers, coupons, content and settings still run on each
app's in-memory mock services — see "What this API does not cover yet".

## What it gives you

- **Owner authentication.** One owner account, bcrypt-hashed password, session in a signed **httpOnly**
  cookie. Every admin write is rejected without a valid session.
- **Public catalog.** `/api/products` and `/api/products/:slug` return **only `active` products in
  `isActive` categories**. Draft and archived products 404 even on a direct URL, so an unpublished
  product is never reachable by guessing its slug.
- **Server-side validation.** Unique slugs and catalogue-wide unique SKUs, no negative prices or stock,
  sale price below price, variants matching their options, and stricter rules to publish (image +
  descriptions + price above zero). The apps validate too, but these rules are the authoritative ones.
- **Atomic writes.** A product and all of its options, values, variants, images and specs are written
  in one transaction: a failure part-way cannot leave a half-saved product.
- **Durable images.** Image bytes live in the database and are served from `/media/:id`, so both apps
  resolve the same URL after a restart — no `blob:` URLs, no local file paths.

## Requirements

- Node.js 18+ (tested on 24)
- A local MySQL/MariaDB server. **XAMPP works out of the box** — just start MySQL from the XAMPP
  Control Panel; its default `root` account has no password, so no setup is needed on the DB side.

## Setup

From the `backend/` folder — works in cmd.exe, PowerShell and Git Bash:

```
npm install
copy .env.example .env      (PowerShell: Copy-Item .env.example .env)
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

### Using PostgreSQL or SQLite instead

The schema runs on all three engines — list-ish fields are JSON text rather than native arrays, and
search uses a pre-lowercased `searchText` column instead of `ILIKE`/`FULLTEXT`. MySQL and PostgreSQL
both need the `@db.Text` attributes already on the long fields in `prisma/schema.prisma`; remove them
for SQLite, which doesn't support native type annotations. Then:

1. `prisma/schema.prisma` → `provider = "postgresql"` (or `"sqlite"`)
2. Point `DATABASE_URL` at the new database
3. `npx prisma migrate dev --name init && npm run db:seed`

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start with reload on change (tsx watch) |
| `npm run build` / `npm start` | Compile to `dist/` and run the compiled server |
| `npm run typecheck` | TypeScript, no emit |
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

See `.env.example`. `DATABASE_URL` must point at a **development** database — `npm run db:reset` drops
the schema. `JWT_SECRET` signs session cookies; set your own. `OWNER_EMAIL` / `OWNER_PASSWORD` seed the
single owner account and should be changed before this API is exposed anywhere.

## Endpoints

### Public (no authentication)

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness + database check |
| GET | `/api/categories` | Active categories, ordered |
| GET | `/api/products` | Active products in active categories. `?q=`, `?category=slug,slug`, `?ids=a,b`, `?limit=` |
| GET | `/api/products/:slug` | One active product; 404 for draft/archived |
| GET | `/media/:id` | Image bytes. Public only while referenced by published content (active product/category, store logo, published collection or homepage); otherwise 404 unless the owner is signed in |
| GET | `/api/orders/track` | `?number=&email=` (rate limited). Trimmed view: status, timeline, lines, totals — no address, phone or email |
| GET | `/api/orders/:id` | Full order (rate limited, `Cache-Control: no-store`). Account order: signed-in owner of that order only. Guest order: `X-Order-Token` header with the one-time token returned by checkout. Anything else: 404 |

### Owner session

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/admin/auth/login` | `{ email, password }` → sets the session cookie |
| POST | `/api/admin/auth/logout` | Clears the cookie |
| GET | `/api/admin/auth/me` | Current owner, or 401 |

### Owner only (401 without a valid session)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/admin/products` | All products, any status. `?q=`, `?status=` |
| GET | `/api/admin/products/:id` | One product, any status |
| POST | `/api/admin/products` | Create (atomic) |
| PUT | `/api/admin/products/:id` | Replace (atomic) |
| PATCH | `/api/admin/products/:id/status` | Publish / unpublish / archive, re-validating publish rules |
| GET | `/api/admin/categories` | Categories with product counts |
| POST/PUT | `/api/admin/categories[/:id]` | Create / update |
| GET | `/api/admin/media` | Image metadata (never the bytes) |
| POST | `/api/admin/media` | Upload `{ fileName, mimeType, base64, alt }` |

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

## What this API does not cover yet

- Card, UPI and wallet payments: modelled end to end but rejected at checkout until a real gateway is
  integrated (cash on delivery works).
- Newsletter sign-up and the contact form (storefront in-memory mocks).
- Product reviews and ratings (the storefront still ships sample reviews; the API returns none)
- Storefront search, filtering, sorting and pagination run client-side over the fetched catalog.
  Moving them into SQL is the natural next step once the catalog grows.

## Security notes

- Passwords are bcrypt-hashed; session cookies are httpOnly, signed and `SameSite=Lax`.
- **CSRF:** login also sets a readable `ys_csrf` cookie. Every POST/PUT/PATCH/DELETE from a signed-in owner
  or customer must echo it in an `X-CSRF-Token` header, or gets 403 (`src/csrf.ts`). Both apps' API clients
  do this automatically. A session from before this was added has no CSRF cookie and must sign in again.
- **Rate limits** (`src/rateLimit.ts`): login (per IP and, separately, per account), registration, password
  reset request (per IP and per account) and confirm, order lookup/tracking, coupon validation, plus a
  coarse limit on all of `/api`. Counters are **in memory**: correct for one backend process, but each
  extra instance behind a load balancer gets its own counters — use a shared store (e.g. Redis) first.
- **Proxy:** per-IP limits depend on `TRUST_PROXY` (see `.env.example`). Leave it `false` unless a reverse
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
