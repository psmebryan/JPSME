-- Tracking for activation invitations: what was sent, what bounced, what expired.
--
-- TABLE NAMES: the User model carries no @@map, so its table is `User`, not
-- `user`. Write it in that exact case — a case-insensitive server (Windows,
-- lower_case_table_names=1) folds it either way, but the case-sensitive Linux
-- host this deploys to cannot resolve `user` at all.
--
-- NO NEW ENUM. status reuses the existing InvitationStatus values, spelled out
-- inline here because MySQL enums are per-column, not shared types. That is
-- deliberate: this server runs a non-strict sql_mode, where writing a value the
-- enum does not list does not raise — the column is silently set to '' instead,
-- and the only symptom is "Value '' not found in enum" on some later READ, a
-- long way from the cause. Reusing a settled value list avoids inventing a new
-- one that code might outgrow. `channel` is a VARCHAR for the same reason.
--
-- Safe to re-run. MySQL DDL is not transactional and this runner records a
-- migration as applied only after the whole file succeeds, so a file that fails
-- halfway leaves its earlier statements committed and un-recorded.

CREATE TABLE IF NOT EXISTS `activation_invites` (
  `id`            INT          NOT NULL AUTO_INCREMENT,
  -- One row per ATTEMPT, not per member. A resend adds a row; nothing here is
  -- overwritten, so "tried three times, two bounced" stays answerable.
  `userId`        INT          NOT NULL,
  -- SITE  = the app sent it over SMTP from a queued job.
  -- MERGO = a person merged it from the exported spreadsheet.
  `channel`       VARCHAR(16)  NOT NULL DEFAULT 'SITE',
  `status`        ENUM('PENDING','SENT','DELIVERED','BOUNCED','FAILED') NOT NULL DEFAULT 'PENDING',
  `failureReason` VARCHAR(255) NULL,
  -- Accepted by the transport, which is not the same as delivered: SMTP
  -- accepting a message means only that Google took custody of it. This is
  -- exactly why BOUNCED can arrive after SENT.
  `sentAt`        DATETIME(3)  NULL,
  `openedAt`      DATETIME(3)  NULL,
  `bouncedAt`     DATETIME(3)  NULL,
  `createdAt`     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  -- The page reads "latest attempt per member", which is this index.
  INDEX `activation_invites_userId_createdAt_idx` (`userId`, `createdAt`),
  -- And the filters read "everyone whose last attempt bounced".
  INDEX `activation_invites_status_idx` (`status`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = 'activation_invites'
      AND CONSTRAINT_NAME = 'activation_invites_userId_fkey') = 0,
  'ALTER TABLE `activation_invites`
     ADD CONSTRAINT `activation_invites_userId_fkey`
     FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- The two new audit actions. NOTE the table is `audit_logs`: unlike User, the
-- AuditLog model carries @@map("audit_logs"), so the model name is not the table
-- name. MODIFY restates the whole list, so applying this
-- twice is a no-op — and it must go in before any code can write these values,
-- for the non-strict sql_mode reason above.
ALTER TABLE `audit_logs` MODIFY `action` ENUM(
  'PAYMENT_CREATED','PAYMENT_PROCESSING','PAYMENT_SUCCEEDED','PAYMENT_FAILED',
  'WEBHOOK_RECEIVED','WEBHOOK_REJECTED','WEBHOOK_DUPLICATE','REFUND_REQUESTED',
  'REFUND_SUCCEEDED','REFUND_FAILED','UNAUTHORIZED_PAYMENT_ACCESS',
  'SUSPICIOUS_PAYMENT_MISMATCH','PAYMENT_RECONCILED','USER_STATUS_CHANGED',
  'AUTO_APPROVAL_FAILED','QR_GENERATED','QR_REGENERATED','CHECKIN_ACCESS_GRANTED',
  'CHECKIN_ACCESS_REVOKED','CHECKIN_UNDONE','SEATING_UPDATED','SEAT_OVERRIDDEN','ROOM_CREATED',
  'ROOM_UPDATED','ROOM_DELETED','ROOM_ATTENDANCE_OVERRIDDEN','USER_ROLE_CHANGED',
  'INTEGRATION_KEY_CREATED','INTEGRATION_KEY_REVOKED','PASSWORD_RESET_REQUESTED',
  'PASSWORD_RESET_COMPLETED','USER_PASSWORD_SET_BY_ADMIN','USER_EMAIL_CHANGED_BY_ADMIN',
  'ACCOUNT_ACTIVATED','ACTIVATION_INVITES_SENT','ACTIVATION_INVITE_RESENT',
  'ACTIVATION_DELIVERY_IMPORTED'
) NOT NULL;
