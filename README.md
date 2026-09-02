# JPSME 2.0

Node.js/Express + Prisma (MySQL) backend, server-rendered EJS + Tailwind (CDN) + vanilla AJAX frontend.
Two sides: public/user pages and an admin panel (logo/content management, user approval, event management).

> **Database note:** this project uses its own database, `jpsme2_new`. The legacy PHP app at
> `C:\xampp\htdocs\jpsme` uses a *different* database, `jpsme2` — never point this project's
> `DATABASE_URL` at `jpsme2`.

## Stack

- **Backend:** Express (plain JavaScript, no TypeScript)
- **ORM:** Prisma, MySQL (XAMPP)
- **Views:** EJS + express-ejs-layouts, Tailwind via CDN
- **Frontend interactivity:** vanilla `fetch`-based AJAX (see `public/js/`)
- **Auth:** session-based (express-session), bcrypt password hashing
- **Security:** helmet (CSP headers), CSRF double-submit token, rate limiting on login, input validation (express-validator)

## Setup

1. Start XAMPP's MySQL service.
2. Create a `.env` in the project root (it is gitignored — never commit it):

   ```
   DATABASE_URL="mysql://root:@localhost:3306/jpsme2_new"
   SESSION_SECRET=<a long random string>
   PORT=3000
   NODE_ENV=development
   APP_URL=http://localhost:3000
   ```

   - `DATABASE_URL` must point at a **dedicated** database, separate from the
     legacy `jpsme2` used by the PHP app at `C:\xampp\htdocs\jpsme`. In
     production append `?connection_limit=...`, kept comfortably under MySQL's
     `max_connections` — see "Scaling & going live".
   - `SESSION_SECRET` signs session cookies. Generate one per environment:
     `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`.
     Startup refuses in production if it is missing, under 32 characters, or a
     known placeholder.
   - Optional: `CLUSTER_WORKERS` (worker processes `npm start` forks, default 1)
     and `TRUST_PROXY=true` — set the latter **only** when actually behind a
     reverse proxy, since trusting `X-Forwarded-*` without one allows IP
     spoofing and breaks rate limiting.
   - Integrations are optional and stay disabled when unset: `PAYMONGO_SECRET_KEY`
     and `PAYMONGO_WEBHOOK_SECRET` (payments), `BREVO_API_KEY` (email),
     `GOOGLE_SHEETS_ID` with `GOOGLE_SERVICE_ACCOUNT_EMAIL` /
     `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` (report sync).

3. Create the database (phpMyAdmin or CLI): `CREATE DATABASE jpsme2_new;`
4. Install dependencies: `npm install`
5. Apply the schema: `npm run prisma:migrate`
6. Seed the initial admin account: `npm run db:seed` (creates `admin@jpsme.local` / prints a generated password — change it after first login, or set `SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD` env vars before seeding)
7. Start the app: `npm run dev` (auto-restart) or `npm start`
8. Visit `http://localhost:3000` (public site) and `http://localhost:3000/admin/login` (admin panel)

## How things fit together

- `src/app.js` — Express app: security middleware, sessions, view engine, route mounting, error handling.
- `src/routes/pages.routes.js` — page routes (server-rendered EJS), protected with `ensureAuth`/`ensureAdmin`.
- `src/routes/api/*` — JSON API routes consumed by the AJAX scripts in `public/js/`, protected with `apiAuth`/`apiAdmin` and CSRF tokens.
- `src/services/*` — business logic + Prisma queries (no Express req/res here).
- `src/controllers/*` — glue between routes and services.
- `prisma/schema.prisma` — data model (`User`, `Event`, `EventRegistration`, `SiteSetting`).

## Key behaviors implemented

- **Self-registration requires admin approval:** new accounts are created with `status: PENDING` and can't log in until an admin approves them from `/admin/users`.
- **One-click event registration:** a logged-in user's saved profile (name/email/phone/school) is used directly when they click "Register" on an event — no form to fill in again.
- **Admin logo upload:** `/admin/settings` lets an admin replace the site logo, stored via the `SiteSetting` table and served from `/uploads/logo/`.
- **Route protection:** page routes redirect (to `/login` or `/admin/login`); API routes return `401`/`403` JSON.

## Scaling & going live

The app is built to run as multiple worker processes behind a shared, persistent session store, so it isn't limited to a single CPU core:

- **CSS:** Tailwind is compiled locally (`npm run build:css`, or `npm run watch:css` while iterating on styles) instead of loaded from a CDN — faster page loads, and it lets the CSP drop `'unsafe-inline'`. The CSP instead uses a per-request nonce (`res.locals.cspNonce`, set in `src/app.js`) that the few legitimate inline `<script>`/`<style>` tags carry explicitly.
- **Sessions:** stored in MySQL via `express-mysql-session` (`src/config/sessionStore.js`), not in memory — they survive restarts and are shared correctly across worker processes.
- **Multiple processes:** `npm start` runs `src/cluster.js`, which forks `CLUSTER_WORKERS` worker processes (Node's built-in `cluster` module) and restarts any that crash. Defaults to 1 (identical to running a single process) until you set `CLUSTER_WORKERS` — a good starting value is one per CPU core. `npm run dev` intentionally stays single-process for simple hot-reloading.
- **DB connections:** with N workers, make sure `N × Prisma's connection pool` stays under MySQL's `max_connections`. Add `?connection_limit=<small number>` to `DATABASE_URL` and raise `max_connections` in `my.ini` if needed.
- **Trust proxy:** only set `TRUST_PROXY=true` once this sits behind a real reverse proxy — otherwise rate limiting and secure-cookie detection can be bypassed via spoofed headers.
- **Before pointing the GoDaddy domain at this:** confirm what kind of Node hosting the plan actually gives you. Shared cPanel/Passenger-style Node hosting manages its own process lifecycle (in which case just point it at `src/server.js` directly and skip `cluster.js`); a VPS gives you full control and can use `CLUSTER_WORKERS` + a reverse proxy as described above. Also set a strong, unique `SESSION_SECRET` and make sure `NODE_ENV=production` so `cookie.secure` turns on (requires HTTPS) — the app now refuses to start in production with a missing, placeholder, or under-32-character `SESSION_SECRET`, so a mistake here surfaces immediately at boot rather than as a silent session-security gap.
