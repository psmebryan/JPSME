-- Password reset links, and the audit actions for changing a credential.
--
-- TABLE NAMES: the User model carries no @@map, so its table is `User`, not
-- `user`. Write it in that exact case — a case-insensitive server (Windows,
-- lower_case_table_names=1) folds it either way, but the case-sensitive Linux
-- host this deploys to cannot resolve `user` at all. Getting this backwards
-- took the live site down once already.
--
-- Written by hand rather than generated: "prisma migrate diff" also emits a
-- DROP TABLE for `sessions` (owned by express-mysql-session, so it reads as
-- drift on every diff), and running that would sign out every logged-in user.
--
-- Safe to re-run. MySQL DDL is not transactional and this runner records a
-- migration as applied only after the whole file succeeds, so a file that fails
-- halfway leaves its earlier statements committed and un-recorded.

CREATE TABLE IF NOT EXISTS `PasswordResetToken` (
  `id`        INT          NOT NULL AUTO_INCREMENT,
  -- One live reset per account. Requesting a second link replaces the first,
  -- so an older stolen mail stops working the moment the real owner asks again.
  `userId`    INT          NOT NULL,
  -- sha256 of "<userId>:<token>", hex. The token is in the emailed link and is
  -- stored nowhere.
  `tokenHash` VARCHAR(191) NOT NULL,
  `expiresAt` DATETIME(3)  NOT NULL,
  -- Set when the password actually changes. A used row is kept rather than
  -- deleted so a second click can say "already used" instead of "invalid".
  `usedAt`    DATETIME(3)  NULL,
  `createdAt` DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `PasswordResetToken_userId_key` (`userId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = 'PasswordResetToken'
      AND CONSTRAINT_NAME = 'PasswordResetToken_userId_fkey') = 0,
  'ALTER TABLE `PasswordResetToken`
     ADD CONSTRAINT `PasswordResetToken_userId_fkey`
     FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- THE ENUM GOES IN BEFORE ANY CODE CAN WRITE IT. This server runs a non-strict
-- sql_mode, where writing a value the enum does not list does not raise — the
-- column is silently set to '' instead, and the only symptom is
-- "Value '' not found in enum" on some later READ, a long way from the cause.
--
-- Re-runnable: MODIFY restates the whole list, so applying it twice is a no-op.
ALTER TABLE `audit_logs`
    MODIFY `action` ENUM(
        'PAYMENT_CREATED','PAYMENT_PROCESSING','PAYMENT_SUCCEEDED','PAYMENT_FAILED',
        'WEBHOOK_RECEIVED','WEBHOOK_REJECTED','WEBHOOK_DUPLICATE','REFUND_REQUESTED',
        'REFUND_SUCCEEDED','REFUND_FAILED','UNAUTHORIZED_PAYMENT_ACCESS',
        'SUSPICIOUS_PAYMENT_MISMATCH','PAYMENT_RECONCILED','USER_STATUS_CHANGED',
        'AUTO_APPROVAL_FAILED','QR_GENERATED','QR_REGENERATED',
        'CHECKIN_ACCESS_GRANTED','CHECKIN_ACCESS_REVOKED','CHECKIN_UNDONE',
        'SEATING_UPDATED','SEAT_OVERRIDDEN',
        'USER_ROLE_CHANGED','ROOM_CREATED','ROOM_UPDATED','ROOM_DELETED',
        'ROOM_ATTENDANCE_OVERRIDDEN',
        'INTEGRATION_KEY_CREATED','INTEGRATION_KEY_REVOKED',
        'PASSWORD_RESET_REQUESTED','PASSWORD_RESET_COMPLETED',
        'USER_PASSWORD_SET_BY_ADMIN','USER_EMAIL_CHANGED_BY_ADMIN'
    ) NOT NULL;
