# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Database note

This project uses its own database, `jpsme2_new`. A legacy PHP app at `C:\xampp\htdocs\jpsme` uses a
*different* database, `jpsme2` — never point this project's `DATABASE_URL` at `jpsme2`.

## Commands

```bash
npm run dev              # single-process, auto-restart on file change (node --watch) — use this for local dev
npm start                # production: forks CLUSTER_WORKERS worker processes via src/cluster.js
npm run build:css        # compile Tailwind once (public/css/tailwind.css)
npm run watch:css        # compile Tailwind on change — run alongside `npm run dev` when touching styles
npm run prisma:migrate   # `prisma migrate dev` — creates + applies a migration from schema.prisma changes
npm run prisma:generate  # regenerate the Prisma client after pulling schema changes without a migrate
npm run db:seed          # seed the initial admin account (admin@jpsme.local, or SEED_ADMIN_EMAIL/PASSWORD)
npm run test:paymongo    # node tests/paymongo.service.test.js — the only automated test in the repo
```

There is no lint script and no general test suite — `tests/paymongo.service.test.js` is a standalone
script, not a framework-driven suite. Views are EJS and are not type-checked or linted; verify changes by
running the dev server and exercising the page.

### Windows/XAMPP Prisma workflow gotchas

- **The Prisma query-engine DLL locks while `node --watch` (or any running server) holds it.** `npx prisma
  generate` fails with `EPERM: operation not permitted, rename ... query_engine-windows.dll.node` if a
  server process is running. Stop all `node.exe` processes first (`Get-Process -Name node | Stop-Process
  -Force` in PowerShell), then run `prisma generate`/`migrate deploy`, then restart the server.
- **Non-interactive migration workflow** (avoids `prisma migrate dev`'s interactive prompts, useful when
  scripting a change): `npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel
  prisma/schema.prisma --script` to get the raw SQL, hand-write it into a new
  `prisma/migrations/<timestamp>_<name>/migration.sql`, then `npx prisma migrate deploy` followed by `npx
  prisma migrate generate`. The diff output always includes a spurious `DROP TABLE sessions` — the
  `sessions` table is owned by `express-mysql-session` (see `src/config/sessionStore.js`), not tracked in
  `schema.prisma`, so **always strip that line** before writing the migration file.
- **MySQL requires a foreign-key column to always have a backing index.** If you replace a plain `@unique`
  with a composite `@@unique` that still covers the FK column, create the new composite index *before*
  dropping the old single-column one in the migration SQL, or MySQL rejects the drop (error 1553).
- **Recovering a failed migration:** `npx prisma migrate status` names the failed migration; if its first
  statement is what failed (nothing partially applied), `npx prisma migrate resolve --rolled-back
  "<name>"` clears the failed-state lock so you can fix the SQL and redeploy.

## Architecture

Express 4, plain JavaScript (no TypeScript/build step for server code), Prisma ORM on MySQL, server-rendered
EJS views, vanilla `fetch`-based AJAX (no frontend framework), Tailwind compiled locally (not CDN).

### Request pipeline (`src/app.js`)

Middleware order matters here: per-request CSP nonce → helmet → raw-body capture (needed later for PayMongo
webhook signature verification, since `express.json()` normally discards the raw bytes) → session
(MySQL-backed via `express-mysql-session`, not in-memory) → CSRF token issuance → static file serving →
`res.locals.currentUser`/`logoUrl` population → **the PENDING-user gate** → route mounting.

The PENDING-user gate is easy to miss: a `USER`-role account with `status === 'PENDING'` gets a real session
(so it can complete membership payment — the admin's approval decision is informed by seeing payment status)
but is confined to `PENDING_USER_ALLOWED_PREFIXES` (`/membership-payment`, `/logout`, `/api/payments`,
`/api/auth/logout`, `/api/csrf-token`) for everything else. Adding a new page/API route that a
not-yet-approved user should be able to reach requires adding its prefix here — otherwise it silently
redirects to `/membership-payment` (pages) or 403s (API).

### Two parallel route trees

- `src/routes/pages.routes.js` — server-rendered EJS pages, gated by `ensureAuth`/`ensureAdmin`/etc.
  (`src/middleware/auth.middleware.js`), redirect-based.
- `src/routes/api/*` — JSON endpoints consumed by `public/js/*.js`, gated by `apiAuth`/`apiAdmin`, returns
  401/403 JSON. Requires the CSRF token (`verifyCsrfToken`) on state-changing requests — the token is a
  double-submit cookie/header pair, issued globally in `app.js` even for anonymous sessions (so public forms,
  like the invitation-request form on the event page, still need it).

Every page and API route delegates to `src/services/*.js` for business logic and Prisma queries; services
never touch `req`/`res`. `src/controllers/*` (both `pages.controller.js` and `controllers/api/*.js`) are the
thin glue layer. When changing behavior, look for the service function first — it's almost never in the
controller.

### Admin panel: SPA-over-server-rendered-EJS

The admin sidebar (`views/admin/layout.ejs` + `public/js/admin-nav.js`) intercepts clicks on
`a[data-admin-link]` and fetches the target page with `X-Requested-With: fragment` instead of a full
navigation. `renderAdmin()` (defined once in `pages.controller.js`, used by every `admin*Page` controller)
checks that header and renders the view with `layout: false` for a fragment response, or the full
`admin/layout` otherwise — so every admin page controller supports both a full load and an AJAX swap for
free, no controller-side branching needed per page. `admin-nav.js` also re-runs `admin.js`'s per-page init
functions after a fragment swap (`admin:content-loaded` event) since the DOM was just replaced.

One recurring bug class here: comparing a link's `href` against `window.location.pathname` alone breaks for
two different sidebar links that share a pathname but differ only by query string (e.g. `/admin/invitations`
vs `/admin/invitations?source=SELF_REQUESTED`) — always compare against `pathname + search`.

### RBAC: three roles, and "admin" splits two ways

`Role` enum: `USER`, `CHAPTER_ADMIN`, `ADMIN`. Most "admin-only" features are actually **MAIN_ADMIN-only**
(`role === 'ADMIN'` exactly, enforced by `apiAdmin`/`ensureMainAdminOnly`) — chapter admins
(`apiAdminOrChapterAdmin`/`ensureAdminOrChapterAdmin`) can only see/manage their own chapter's members
(`req.chapterScope`, set by the middleware). When adding a new admin feature, check which tier it belongs to
by looking at a sibling route in the same area rather than assuming — invitations, payments, broadcasts,
settings, and sponsors are all MAIN_ADMIN-only; user/chapter-member management is shared with chapter admins
scoped to their own chapter.

Separately, `userService.listByStatus()` (used to populate the member picker for invitations) always
excludes `role: 'ADMIN'` accounts — this is intentional (admins aren't "members" and can't register for
events either), not a bug; the workaround when an admin genuinely needs to be invited to an event is the
invitations page's "External Contact" manual-entry field, which has no role filtering.

### Membership lifecycle: register → verify → (pay) → approve

New `USER` accounts start `status: PENDING`, `emailVerifiedAt: null`. Login is blocked until email
verification (`emailVerification.service.js`, 24h token). Once verified, login succeeds but the PENDING gate
above confines the user to `/membership-payment` until an admin approves them — **or**, if the membership
fee is paid via PayMongo, `payment.service.js`'s `applyPaymentPaid` auto-approves the account itself
(`userService.setStatus(..., 'APPROVED', { reason: 'MEMBERSHIP_PAYMENT_CONFIRMED' })`), mirroring exactly
what the admin's manual "Approve" button does (same status transition, same audit log, same approval email)
rather than duplicating that logic. If auto-approval itself throws, it's caught and logged as an
`AUTO_APPROVAL_FAILED` audit entry rather than silently lost — check the admin Audit Log page, not just
server logs, if a paid account seems stuck at PENDING.

`postApprovalRedirectUrl` on `User`: set when someone registers an account from an event invitation link
(`?next=` param threaded through `/register` → the verification email → the eventual first post-approval
login), so that first login lands them back on the event instead of the generic profile page. Read once,
then cleared — a one-time redirect, not a general "last visited page" feature.

### Event registration: free vs. paid, and the invitation layer on top

`EventRegistration.status`: `REGISTERED`, `PENDING_PAYMENT` (holds the capacity slot while a paid
registration's checkout is in flight), `CANCELLED`. A free event goes straight to `REGISTERED`; a paid one
(`Event.feeCentavos > 0`) goes through `payment.service.js`'s `createEventCheckout` → PayMongo Checkout
Session → webhook confirms → `applyPaymentPaid` flips `PENDING_PAYMENT` to `REGISTERED` (never the checkout
creation itself, and never trust the browser redirect back from PayMongo as confirmation — only the verified
webhook, or admin-triggered reconciliation against PayMongo's API, can do that).

`EventInvitation` is a separate tracking layer, not a gate on registration — an admin can invite existing
members (picked from the roster) or "External Contact"s (typed in, no account), and the public can
self-request an invitation from the event page (`source: SELF_REQUESTED` vs `ADMIN_SENT`). A member invitee
(`userId` set) who registers gets `EventInvitation.registeredAt` set automatically
(`invitation.service.js`'s `markRegistered`, called from the registration flow) — this is what lets the
admin's Invitation Report compare "invited" against "registered." A **guest** invitee (`userId` null) has no
registration path at all; instead they get a lightweight RSVP (`rsvpStatus`: `ATTENDING`/`NOT_ATTENDING`,
recorded via a public, unauthenticated, token-only endpoint) plus a separate "become a member" link if they
want to actually register. Don't conflate `registeredAt` (real registration, requires an account) with
`rsvpStatus` (guest-only, no account) — they're deliberately different signals for different audiences.

Invitation delivery tracking depends on Brevo webhooks (`api/webhooks/brevo`, signed via a shared-secret
query param since Brevo doesn't sign requests) which are **best-effort and can silently drop events** —
confirmed empirically (an "opened" event existed in Brevo's own Statistics API but its webhook never
arrived). `src/jobs/invitationReconciliationSweep.job.js` polls Brevo's Statistics API directly every 30
minutes as a backstop for invitations still `SENT` or missing `openedAt` within the last 14 days, always
using the event's own recorded timestamp, never "now." The Brevo webhook also requires an externally
reachable URL (this project develops against an ngrok tunnel) — if invitation statuses seem stuck, check
whether the tunnel is actually still up before assuming the code is wrong (ngrok's free tier drops
`ERR_NGROK_3200` when the tunnel is offline; if a *static* free-tier domain is configured, restarting ngrok
reuses the same URL and Brevo's webhook registration doesn't need to change).

### Payments (PayMongo): Checkout Sessions, not Payment Intents

`paymongo.service.js` uses PayMongo's **Checkout Sessions** API exclusively (a hosted page PayMongo
controls — the app never collects card/GCash credentials itself), not the Payment Intents API (a different,
manual-card-collection PayMongo integration style — don't reach for `createAPaymentintent`-style calls,
they don't exist in this codebase and aren't the intended pattern).

The payer, not JPSME, covers PayMongo's own transaction fee: `payment.service.js`'s `createCheckout` grosses
up the charge (`calculateGatewaySurcharge`, rate configurable at Admin → Settings, no safety buffer by
design) so the *base* fee amount is what JPSME nets. This is charged as its own separate PayMongo line item
("Payment processing fee"), not folded into one number, so PayMongo's own checkout page itemizes it for the
payer. Separately, once a payment actually settles, PayMongo's real reported `fee`/`net_amount` (not the
upfront estimate) is captured onto `Payment.gatewayFeeCentavos` for accounting — the admin Payments report
and the "Amount Paid / Fee Deducted / Net Received" columns in the synced Google Sheet both come from this
real captured value, not the estimate. The two numbers can differ by a centavo or two due to rounding
differences between the estimate formula and PayMongo's own internal calculation — that's expected, not a
bug.

`applyPaymentPaid`/`applyPaymentFailed` are the single choke points for a payment reaching a terminal state,
shared between the live webhook handler and admin-triggered reconciliation (`reconcilePayment`) — so both
paths get identical side effects (registration flip, invitation `registeredAt`, confirmation email, audit
log) instead of two hand-maintained copies that could drift.

### Email templates: per-purpose, not per-caller

`EmailTemplate` rows are looked up by a compound `(eventId, purpose)` key (`EmailTemplatePurpose`:
`MEMBER_APPROVED`, `EVENT_REGISTRATION`, `EVENT_INVITATION`) — `MEMBER_APPROVED` is the one purpose with
`eventId: null` (a single global row; MySQL allows multiple NULLs in a unique index, so this doesn't collide
with itself). `emailTemplateService.js`'s `getEventTemplateByPurpose(eventId, purpose, defaults)` is the
shared find-or-create helper both `getEventTemplate` (registration) and `getEventInvitationTemplate`
(invitation) call — add a new per-event email purpose through this helper, not a hand-rolled copy. Templates
are plain-text with `{{token}}` placeholders substituted via `src/utils/templateTokens.js`'s
`substituteTokens`; `mail.service.js` builds the `fields` object per email type and is the only place that
knows which tokens a given email actually supports.

### Google Sheets live sync (`sheetsSync.service.js`)

One tab per event for both registrations (`Event #<id> - <title>`) and invitations (`Invites #<id> -
<title>`) — deliberately not one combined cross-event tab, since that grows unbounded and eventually floods
a single sheet as event/invitation volume increases. Tabs are matched by a stable `Event #<id> `/`Invites
#<id> ` prefix rather than the full title, so renaming an event renames its tab instead of orphaning a
duplicate. Every sync is a full clear-and-rewrite of that one tab (`writeTab`), not a surgical cell update —
simpler and always correct at this app's write volume. One tab, `Contacts to Invite`, is the only one this
service ever *reads from* rather than overwrites — it's admin-maintained (a bulk-import source for the
invitation "External Contact" flow) and is only ever auto-created with a header row if missing, never
rewritten after that.

Sync calls are fire-and-forget (`.syncX(...)`, no `await` at most call sites, wrapped in try/catch inside
the sync functions themselves) — they must never block or fail the user-facing action that triggered them.
`syncInvitations(eventId)` is called after every meaningful invitation state change (send, resend, RSVP,
registration, webhook-driven status/open update); the reconciliation sweep collects the *set* of affected
event IDs across its whole batch and syncs each once at the end, not once per row.

### Chapters: a three-level hierarchy

`ChapterRegion` → `ChapterArea` → `Chapter`. A member belongs to a `Chapter`; a `ChapterAdmin` is a
`User` (role `CHAPTER_ADMIN`) assigned to manage one `Chapter`'s members. `ChapterAdminAudit` tracks
assignment/removal history separately from the general `AuditLog`.
