-- Phase 4: the Finance & Logistics role, and the daily reconciliation.
--
--   User.role               + FINANCE_LOGISTICS: an admin who runs the store
--                           day to day. What each one may do is ticked per
--                           account (admin_grants), not for the role.
--   admin_grants            the ticks of one account: Finance tasks, Logistics
--                           tasks, Payments (view), Reports
--   merch_reconciliations   one row per day Finance checked the store's paid
--                           orders against PayMongo: matched, or the gaps
--
-- Only adds: every existing account keeps its role. Guarded so a retry after a
-- partial run is harmless.

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'User' AND COLUMN_NAME = 'role'
     AND COLUMN_TYPE LIKE '%FINANCE_LOGISTICS%') = 0,
  'ALTER TABLE `User` MODIFY `role` ENUM(''USER'', ''ADMIN'', ''CHAPTER_ADMIN'', ''PRESIDENT'', ''FINANCE_LOGISTICS'') NOT NULL DEFAULT ''USER''',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

CREATE TABLE IF NOT EXISTS `admin_grants` (
  `userId` INTEGER NOT NULL,
  `modules` TEXT NOT NULL,
  `updatedById` INTEGER NULL,
  `updatedAt` DATETIME(3) NOT NULL,

  PRIMARY KEY (`userId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

SET @migration_sql = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'admin_grants' AND CONSTRAINT_NAME = 'admin_grants_userId_fkey') = 0,
  'ALTER TABLE `admin_grants` ADD CONSTRAINT `admin_grants_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE', 'SELECT 1');
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

CREATE TABLE IF NOT EXISTS `merch_reconciliations` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `day` DATE NOT NULL,
  `status` VARCHAR(10) NOT NULL,
  `siteCount` INTEGER NOT NULL DEFAULT 0,
  `siteCentavos` INTEGER NOT NULL DEFAULT 0,
  `feeCentavos` INTEGER NOT NULL DEFAULT 0,
  `gaps` TEXT NULL,
  `note` VARCHAR(500) NULL,
  `checkedById` INTEGER NULL,
  `checkedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `merch_reconciliations_day_key`(`day`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

SET @migration_sql = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'merch_reconciliations' AND CONSTRAINT_NAME = 'merch_reconciliations_checkedById_fkey') = 0,
  'ALTER TABLE `merch_reconciliations` ADD CONSTRAINT `merch_reconciliations_checkedById_fkey` FOREIGN KEY (`checkedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE', 'SELECT 1');
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;
