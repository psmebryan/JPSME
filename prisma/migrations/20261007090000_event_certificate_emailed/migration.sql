-- When each event certificate was last emailed to its owner.
--
-- Lets "Send certificates" go to everybody not yet sent to, and pick up where
-- it left off after the email provider's daily limit, without emailing anyone
-- twice. Regenerating a certificate clears it, so the corrected one can be sent.
--
-- Guarded so a retry after a partial run is harmless: MySQL DDL is not
-- transactional.

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'event_certificates' AND COLUMN_NAME = 'emailedAt') = 0,
  'ALTER TABLE `event_certificates` ADD COLUMN `emailedAt` DATETIME(3) NULL',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
