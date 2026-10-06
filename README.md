# JPSME 2.0

Membership and events platform for the Junior Philippine Society of Mechanical
Engineers. Node.js, Express, Prisma/MySQL, server-rendered EJS.

## Requirements

- Node.js 18+
- MySQL 8+
- npm

## Setup

1. Start MySQL.
2. Create an empty database for this project. It must be its own — if an older
   PHP application is installed on the same server, confirm which database
   belongs to which before continuing, or migrations will run against the
   wrong data.
3. Create a `.env` in the project root. It is gitignored; never commit it.

   ```
   DATABASE_URL="mysql://<user>:<password>@<host>:<port>/<database>"
   SESSION_SECRET=<see below>
   PORT=3000
   NODE_ENV=development
   APP_URL=http://localhost:3000
   ```

   Generate `SESSION_SECRET` per environment:

   ```
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
   ```

   Optional integrations stay disabled while unset — see `src/config/index.js`
   for the full list of recognised variables and their defaults.

4. `npm install`
5. `npm run prisma:migrate`
6. `npm run db:seed` — creates the first administrator and prints a generated
   password once. Save it; it cannot be recovered afterwards. Set
   `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` beforehand to choose your own.
7. `npm run dev`

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Development server, restarts on change |
| `npm start` | Production server |
| `npm run build:css` | Compile Tailwind once |
| `npm run watch:css` | Compile Tailwind on change |
| `npm run prisma:migrate` | Create and apply a migration |
| `npm run prisma:generate` | Regenerate the Prisma client |
| `npm run db:seed` | Create the first administrator |
| `npm run test:organizations` | Organization hierarchy tests |
| `npm run test:attachment` | Member/organization attachment tests |
| `npm run test:paymongo` | Payment error-handling tests |
| `npm run test:mergo-activations` | Isolated Mergo campaign and status-sync tests |
| `npm run test:mergo-activation-completion` | Dev-database test for activation completion |

### Mergo activation campaign sheet

The Activations page can prepare selected members in a managed Google Sheet for
Mergo. JPSME creates and stores the one-time activation links; Mergo sends the
campaign; JPSME reads Mergo's status column when an admin clicks **Refresh email
status** or while the page refreshes in the background. Importing members on
this page automatically selects newly created accounts for the Mergo step.
Mergo does not determine whether an account activated.

Configure these server-side environment values:

| Variable | Purpose |
| --- | --- |
| `MERGO_ACTIVATION_SHEET_ID` | ID of the dedicated activation campaign spreadsheet |
| `MERGO_ACTIVATION_TAB` | Optional worksheet name; defaults to `JPSME Activations` |
| `MERGO_DAILY_ACTIVATION_CAP` | Optional initial JPSME cap; defaults to `2000` for the stated Mergo plan, and an admin can change it on Activations |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Existing Sheets service account email |
| `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` | Existing Sheets service account private key |
| `ACTIVATION_EMAIL_CHANNEL` | Optional, `mergo` (default) or `site`. **mergo**: imports add new members to the campaign sheet and Mergo sends from a Gmail draft — the right choice past the site provider's daily limit. **site**: importing emails nobody; an admin presses **Send activation links** on Invite Members and the site sends the emails itself (Brevo or SMTP, with the built-in design). |
| `ACTIVATION_SEND_BATCH_LIMIT` | Optional, 1–5000. Most activation emails one **Send activation links** press queues; defaults to `250`, inside Brevo's free 300-a-day limit shared with every other email the site sends. Press again (the next day, on a free plan) for the rest. |
| `ACTIVATION_LINK_DAYS` | Optional, 1–14. How many days an activation link works; defaults to `3`. The clock starts when JPSME prepares the row, not when Mergo sends it, so launch the campaign promptly. Keep the Gmail draft's "This link works for N days" wording in step. |
| `MERGO_ALLOW_LOCAL_LINKS` | Optional, `true` only on a local copy pointed at a **test** sheet. Without it, nothing is written to the campaign sheet unless `APP_URL` is the live `https://` address — links from a local copy point at that computer and its database, and never work for a real member. |

Share the dedicated spreadsheet with the service account as an editor. Keep the
spreadsheet private to authorized staff: it contains live bearer activation
links. The backend creates the worksheet headers and writes JPSME-owned columns;
it leaves Mergo's `Merge Status` column alone. In Mergo, choose the `Email`
column and use `{{First Name}}`, `{{Activation Button}}` and `{{Activation Link}}` in the Gmail draft, typed as ordinary text (Gmail's link box will not take a marker). `Activation Button` is a `=HYPERLINK(link, IMAGE(...))` formula JPSME writes for each row, which Mergo sends as a clickable button image served from `/img/mergo-activate-button-sm.png`. See `docs/mergo-activation-email-template.html`.
When an import creates member accounts, JPSME prepares their activation links
and adds those rows to the campaign sheet automatically. Launch the campaign
through Mergo, or enable its **For each new row** schedule (which can send as
soon as imported rows appear).
The daily cap defaults to the stated Mergo plan limit of 2,000 sends and is a
JPSME guardrail, not a reading of Google's remaining mailbox quota.

Apply the `20261001090000_mergo_activation_attempts` migration before running
this code against a deployment database. On the managed host, use the project's
direct migration runner (`RUN_MIGRATIONS_ON_BOOT=true`) before enabling the
Mergo workflow.

## Architecture

Read the code — `src/routes/` for the entry points, `src/services/` for the
business logic. Deployment, scaling and configuration notes are kept in the
team's internal documentation rather than here.
