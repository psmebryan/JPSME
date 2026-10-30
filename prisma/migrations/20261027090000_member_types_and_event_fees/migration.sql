-- Member types and per-type event fees.
--
--   member_types   the Master List an admin keeps (up to three, enforced by
--                  the app): e.g. Student, Regular, Associate
--   User           memberTypeId, set by an admin; null = no type
--   event_fees     one fee per (event, member type); a registrant pays the
--                  fee for their type, or the event's own feeCentavos when
--                  there is none ("everyone else")
--   EventRegistration
--                  feeCentavos and memberTypeName, a snapshot of what applied
--                  when they registered, so renaming a type or changing a fee
--                  later never rewrites what somebody was told they owed
--
-- Guarded throughout so a retry after a partial run is harmless: MySQL DDL is
-- not transactional.

CREATE TABLE IF NOT EXISTS `member_types` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(60) NOT NULL,
  `sortOrder` INTEGER NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `member_types_name_key`(`name`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `event_fees` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `eventId` INTEGER NOT NULL,
  `memberTypeId` INTEGER NOT NULL,
  `feeCentavos` INTEGER NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `event_fees_eventId_memberTypeId_key`(`eventId`, `memberTypeId`),
  INDEX `event_fees_memberTypeId_idx`(`memberTypeId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'User' AND COLUMN_NAME = 'memberTypeId') = 0,
  'ALTER TABLE `User` ADD COLUMN `memberTypeId` INTEGER NULL, ADD INDEX `User_memberTypeId_idx`(`memberTypeId`)',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'EventRegistration' AND COLUMN_NAME = 'feeCentavos') = 0,
  'ALTER TABLE `EventRegistration` ADD COLUMN `feeCentavos` INTEGER NULL',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'EventRegistration' AND COLUMN_NAME = 'memberTypeName') = 0,
  'ALTER TABLE `EventRegistration` ADD COLUMN `memberTypeName` VARCHAR(60) NULL',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'User' AND CONSTRAINT_NAME = 'User_memberTypeId_fkey') = 0,
  'ALTER TABLE `User` ADD CONSTRAINT `User_memberTypeId_fkey` FOREIGN KEY (`memberTypeId`) REFERENCES `member_types`(`id`) ON DELETE SET NULL ON UPDATE CASCADE',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'event_fees' AND CONSTRAINT_NAME = 'event_fees_eventId_fkey') = 0,
  'ALTER TABLE `event_fees` ADD CONSTRAINT `event_fees_eventId_fkey` FOREIGN KEY (`eventId`) REFERENCES `Event`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'event_fees' AND CONSTRAINT_NAME = 'event_fees_memberTypeId_fkey') = 0,
  'ALTER TABLE `event_fees` ADD CONSTRAINT `event_fees_memberTypeId_fkey` FOREIGN KEY (`memberTypeId`) REFERENCES `member_types`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;
