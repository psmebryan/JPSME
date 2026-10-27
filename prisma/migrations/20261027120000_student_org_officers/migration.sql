-- Student Organization Master: a president on each organization, and its list
-- of officers (name, position, term), kept by a main admin.
--
-- Guarded so a retry after a partial run is harmless.

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'organizations' AND COLUMN_NAME = 'president') = 0,
  'ALTER TABLE `organizations` ADD COLUMN `president` VARCHAR(150) NULL',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

CREATE TABLE IF NOT EXISTS `organization_officers` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `organizationId` INTEGER NOT NULL,
  `name` VARCHAR(150) NOT NULL,
  `position` VARCHAR(100) NOT NULL,
  `termYear` VARCHAR(20) NULL,
  `sortOrder` INTEGER NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  INDEX `organization_officers_organizationId_idx`(`organizationId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'organization_officers' AND CONSTRAINT_NAME = 'organization_officers_organizationId_fkey') = 0,
  'ALTER TABLE `organization_officers` ADD CONSTRAINT `organization_officers_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;
