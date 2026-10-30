-- Member types get their own membership fees and an on/off switch.
--
--   isActive               off = hidden from new choices (membership and event
--                          registration); members who already have the type
--                          keep it, and past registrations and payments keep
--                          what they recorded
--   membershipFeeCentavos  the membership fee for this type
--
-- Its own migration rather than an edit to 20261027090000, which may already
-- be recorded as applied. Guarded so a retry after a partial run is harmless.

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'member_types' AND COLUMN_NAME = 'isActive') = 0,
  'ALTER TABLE `member_types` ADD COLUMN `isActive` BOOLEAN NOT NULL DEFAULT true',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'member_types' AND COLUMN_NAME = 'membershipFeeCentavos') = 0,
  'ALTER TABLE `member_types` ADD COLUMN `membershipFeeCentavos` INTEGER NULL',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

