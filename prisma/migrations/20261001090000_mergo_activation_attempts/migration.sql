-- Extend existing activation history with stable Mergo campaign attempt data.
-- MySQL DDL is not transactional, so every added column is guarded and this
-- migration can safely be retried after a partial application.

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'activation_invites' AND COLUMN_NAME = 'attemptId') = 0,
  'ALTER TABLE `activation_invites` ADD COLUMN `attemptId` VARCHAR(40) NULL',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'activation_invites' AND COLUMN_NAME = 'email') = 0,
  'ALTER TABLE `activation_invites` ADD COLUMN `email` VARCHAR(255) NULL',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'activation_invites' AND COLUMN_NAME = 'tokenHash') = 0,
  'ALTER TABLE `activation_invites` ADD COLUMN `tokenHash` VARCHAR(64) NULL',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'activation_invites' AND COLUMN_NAME = 'campaignId') = 0,
  'ALTER TABLE `activation_invites` ADD COLUMN `campaignId` VARCHAR(100) NULL',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'activation_invites' AND COLUMN_NAME = 'sheetRow') = 0,
  'ALTER TABLE `activation_invites` ADD COLUMN `sheetRow` INT NULL',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'activation_invites' AND COLUMN_NAME = 'retryOfAttemptId') = 0,
  'ALTER TABLE `activation_invites` ADD COLUMN `retryOfAttemptId` VARCHAR(40) NULL',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'activation_invites' AND COLUMN_NAME = 'providerStatus') = 0,
  'ALTER TABLE `activation_invites` ADD COLUMN `providerStatus` VARCHAR(24) NOT NULL DEFAULT ''PREPARED''',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

-- Keep the old activation history truthful after adding the distinct provider
-- state. Only legacy rows are backfilled, so retries remain safe.
UPDATE `activation_invites`
SET `providerStatus` = CASE
  WHEN `status` = 'BOUNCED' THEN 'BOUNCED'
  WHEN `status` = 'FAILED' THEN 'FAILED'
  WHEN `openedAt` IS NOT NULL THEN 'OPENED'
  WHEN `sentAt` IS NOT NULL THEN 'SENT'
  ELSE 'PREPARED'
END
WHERE `attemptId` IS NULL;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'activation_invites' AND COLUMN_NAME = 'failedAt') = 0,
  'ALTER TABLE `activation_invites` ADD COLUMN `failedAt` DATETIME(3) NULL',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'activation_invites' AND COLUMN_NAME = 'activatedAt') = 0,
  'ALTER TABLE `activation_invites` ADD COLUMN `activatedAt` DATETIME(3) NULL',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'activation_invites' AND COLUMN_NAME = 'lastSyncedAt') = 0,
  'ALTER TABLE `activation_invites` ADD COLUMN `lastSyncedAt` DATETIME(3) NULL',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'activation_invites' AND INDEX_NAME = 'activation_invites_attemptId_key') = 0,
  'CREATE UNIQUE INDEX `activation_invites_attemptId_key` ON `activation_invites` (`attemptId`)',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'activation_invites' AND INDEX_NAME = 'activation_invites_providerStatus_createdAt_idx') = 0,
  'CREATE INDEX `activation_invites_providerStatus_createdAt_idx` ON `activation_invites` (`providerStatus`, `createdAt`)',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
