-- Tracks when a member last logged in; null means never.
--
-- Drives the first-login landing rule: the first login after registering goes
-- to /profile so a new member meets their membership card, and every login
-- after that goes to the site home.
--
-- NOTE: "prisma migrate diff" also emitted a DROP TABLE for the `sessions` table
-- here. That table belongs to express-mysql-session, not Prisma, so it shows
-- up as drift on every diff; removed by hand. Running it would sign out every
-- logged-in user. Do not re-add it when regenerating this file.
--
-- Nullable with no backfill on purpose: every EXISTING account therefore reads
-- as "never logged in" and gets the /profile landing once, then behaves
-- normally. That is the desired outcome - the alternative, backfilling
-- createdAt, would fabricate a login that never happened.

-- AlterTable
ALTER TABLE `user` ADD COLUMN `lastLoginAt` DATETIME(3) NULL;


