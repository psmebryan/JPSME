-- Credentials that let another system scan this event's tickets.
--
-- The QR payload is opaque (32 random bytes, encoding nothing), so a second
-- system can only act on a scan by asking this server. This table is what lets
-- it ask, without being given a staff account and without being handed a copy
-- of every live token.
--
-- TABLE NAMES: the Event and User models carry no @@map, so their tables are
-- named exactly as the models are — `Event` and `User`, not `event`/`user`.
-- Write them in that exact case.
--
-- A case-INSENSITIVE server (Windows, lower_case_table_names=1) folds `Event`
-- to `event` and works either way; the case-SENSITIVE Linux host this deploys
-- to (lower_case_table_names=0) has a real table called `Event` and cannot
-- resolve `event` at all. Getting this backwards took the live site down once
-- already, with ER_FK_CANNOT_OPEN_PARENT on the first foreign key.
--
-- Written by hand rather than generated: "prisma migrate diff" also emits a
-- DROP TABLE for `sessions` (owned by express-mysql-session, so it reads as
-- drift on every diff), and running that would sign out every logged-in user.
--
-- Safe to re-run. MySQL DDL is not transactional and this runner records a
-- migration as applied only after the whole file succeeds, so a file that fails
-- halfway leaves its earlier statements committed and un-recorded — and the
-- retry then dies on "table already exists" instead of finishing the job.

CREATE TABLE IF NOT EXISTS `event_integration_keys` (
  `id`         INT          NOT NULL AUTO_INCREMENT,
  `eventId`    INT          NOT NULL,
  `label`      VARCHAR(191) NOT NULL,
  -- The public half of the credential, presented in the clear and looked up
  -- directly. Unique so authentication is one indexed read.
  `keyId`      VARCHAR(191) NOT NULL,
  -- SHA-256 of the secret half, hex — 64 characters. The secret is shown once,
  -- at creation, and stored nowhere.
  `secretHash` VARCHAR(191) NOT NULL,
  `createdBy`  INT          NULL,
  `createdAt`  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `lastUsedAt` DATETIME(3)  NULL,
  `revokedAt`  DATETIME(3)  NULL,
  `revokedBy`  INT          NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `event_integration_keys_keyId_key` (`keyId`),
  INDEX `event_integration_keys_eventId_idx` (`eventId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Foreign keys, each guarded so a re-run adds only what is missing.
--
-- information_schema rather than "ADD CONSTRAINT IF NOT EXISTS", which MySQL
-- does not have for foreign keys.

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = 'event_integration_keys'
      AND CONSTRAINT_NAME = 'event_integration_keys_eventId_fkey') = 0,
  'ALTER TABLE `event_integration_keys`
     ADD CONSTRAINT `event_integration_keys_eventId_fkey`
     FOREIGN KEY (`eventId`) REFERENCES `Event`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- SetNull, not Cascade: deleting the admin who issued a key must not delete the
-- key and silently break a working integration in the middle of an event.
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = 'event_integration_keys'
      AND CONSTRAINT_NAME = 'event_integration_keys_createdBy_fkey') = 0,
  'ALTER TABLE `event_integration_keys`
     ADD CONSTRAINT `event_integration_keys_createdBy_fkey`
     FOREIGN KEY (`createdBy`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = 'event_integration_keys'
      AND CONSTRAINT_NAME = 'event_integration_keys_revokedBy_fkey') = 0,
  'ALTER TABLE `event_integration_keys`
     ADD CONSTRAINT `event_integration_keys_revokedBy_fkey`
     FOREIGN KEY (`revokedBy`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
