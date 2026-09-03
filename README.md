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
| `npm run seed:dummy` | Test members (`-- --clean` removes them) |
| `npm run test:organizations` | Organization hierarchy tests |
| `npm run test:attachment` | Member/organization attachment tests |
| `npm run test:paymongo` | Payment error-handling tests |

## Architecture

Read the code — `src/routes/` for the entry points, `src/services/` for the
business logic. Deployment, scaling and configuration notes are kept in the
team's internal documentation rather than here.
