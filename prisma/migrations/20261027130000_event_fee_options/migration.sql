-- Event fee options, per event (Master List -> Event Fee).
--
--   event_fee_options  each event's own list of registration fees, e.g.
--                      "Student" PHP 300 and "Professional" PHP 800, each with
--                      an Active switch. A registrant must pick one of the
--                      event's active options; an event with none charges its
--                      single Event.feeCentavos, as before.
--   EventRegistration.feeOptionName
--                      a snapshot of the option picked, so renaming one later
--                      never rewrites what somebody registered under
--
-- event_fees (fees per member type, from 20261027090000) is superseded and no
-- longer read. It is left in place rather than dropped, so nothing that may
-- already have been entered is destroyed by a deploy.
--
-- Guarded so a retry after a partial run is harmless.

CREATE TABLE IF NOT EXISTS `event_fee_options` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `eventId` INTEGER NOT NULL,
  `name` VARCHAR(60) NOT NULL,
  `feeCentavos` INTEGER NOT NULL DEFAULT 0,
  `isActive` BOOLEAN NOT NULL DEFAULT true,
  `sortOrder` INTEGER NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `event_fee_options_eventId_name_key`(`eventId`, `name`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'event_fee_options' AND CONSTRAINT_NAME = 'event_fee_options_eventId_fkey') = 0,
  'ALTER TABLE `event_fee_options` ADD CONSTRAINT `event_fee_options_eventId_fkey` FOREIGN KEY (`eventId`) REFERENCES `Event`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'EventRegistration' AND COLUMN_NAME = 'feeOptionName') = 0,
  'ALTER TABLE `EventRegistration` ADD COLUMN `feeOptionName` VARCHAR(60) NULL',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;
