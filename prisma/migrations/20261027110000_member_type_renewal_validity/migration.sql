-- Member types become NEW or RENEWAL rates with their own validity.
--
--   renewable      false = a NEW rate, offered to someone availing membership
--                  for the first time; true = a RENEWAL rate, offered to a
--                  member whose membership has lapsed
--   validityYears  how long a membership bought at this rate lasts; null =
--                  lifetime. Defaults to 1, the validity every membership had
--                  before this.
--
-- Guarded so a retry after a partial run is harmless.

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'member_types' AND COLUMN_NAME = 'renewable') = 0,
  'ALTER TABLE `member_types` ADD COLUMN `renewable` BOOLEAN NOT NULL DEFAULT false',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'member_types' AND COLUMN_NAME = 'validityYears') = 0,
  'ALTER TABLE `member_types` ADD COLUMN `validityYears` INTEGER NULL DEFAULT 1',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;
