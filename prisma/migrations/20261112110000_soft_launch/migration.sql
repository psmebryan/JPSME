-- Phase 5: the soft launch.
--
--   merch_testers    the accounts (the National Board) who may see and buy
--                    from the Store while it is in soft launch
--   merch_feedback   "Report a problem" from the Store during the soft launch,
--                    for staff to fix and mark done
--
-- Only adds. Guarded so a retry after a partial run is harmless.

CREATE TABLE IF NOT EXISTS `merch_testers` (
  `userId` INTEGER NOT NULL,
  `addedById` INTEGER NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`userId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

SET @migration_sql = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'merch_testers' AND CONSTRAINT_NAME = 'merch_testers_userId_fkey') = 0,
  'ALTER TABLE `merch_testers` ADD CONSTRAINT `merch_testers_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE', 'SELECT 1');
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

CREATE TABLE IF NOT EXISTS `merch_feedback` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `userId` INTEGER NULL,
  `orderNumber` VARCHAR(30) NULL,
  `page` VARCHAR(200) NULL,
  `message` VARCHAR(1000) NOT NULL,
  `status` VARCHAR(10) NOT NULL DEFAULT 'OPEN',
  `note` VARCHAR(300) NULL,
  `resolvedById` INTEGER NULL,
  `resolvedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `merch_feedback_status_idx`(`status`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

SET @migration_sql = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'merch_feedback' AND CONSTRAINT_NAME = 'merch_feedback_userId_fkey') = 0,
  'ALTER TABLE `merch_feedback` ADD CONSTRAINT `merch_feedback_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE', 'SELECT 1');
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;
