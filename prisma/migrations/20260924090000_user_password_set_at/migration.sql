-- When the owner of an account last chose their own password.
--
-- NULL means they never have: the account was created for them by a spreadsheet
-- import and is waiting to be activated. That state has to be distinguishable
-- from a normal PENDING signup, because approving somebody who has never
-- activated achieves nothing — they still have no usable password.
--
-- TABLE NAME: the User model carries no @@map, so its table is `User`, not
-- `user`. Write it in that exact case. A case-insensitive server (Windows,
-- lower_case_table_names=1) folds it either way; the case-sensitive Linux host
-- this deploys to cannot resolve `user` at all.
--
-- Written by hand rather than generated: "prisma migrate diff" also emits a
-- DROP TABLE for `sessions` (owned by express-mysql-session, so it reads as
-- drift on every diff), and running that would sign out every logged-in user.
--
-- Safe to re-run. MySQL has no "ADD COLUMN IF NOT EXISTS", so the column asks
-- information_schema first — MySQL DDL is not transactional and this runner
-- records a migration as applied only after the whole file succeeds, so a file
-- that fails halfway leaves its earlier statements committed and un-recorded.

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'User'
      AND COLUMN_NAME = 'passwordSetAt') = 0,
  'ALTER TABLE `User` ADD COLUMN `passwordSetAt` DATETIME(3) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- THE BACKFILL, which is the whole risk in this migration.
--
-- Every account that exists right now was created by somebody registering and
-- choosing a password. Leaving them NULL would declare the entire existing
-- membership "never activated" — which would lock all of them out of the login
-- form the moment the ACCOUNT_NOT_ACTIVATED branch ships, and flood the admin
-- list with hundreds of accounts awaiting an activation that is not coming.
--
-- createdAt rather than NOW(): it is the closest thing on the row to when the
-- password was actually set, and "sometime around when they signed up" is true
-- where "the moment this migration ran" is not.
--
-- Bounded by IS NULL so a re-run cannot overwrite a real activation timestamp
-- recorded between the two runs.
UPDATE `User` SET `passwordSetAt` = `createdAt` WHERE `passwordSetAt` IS NULL;
