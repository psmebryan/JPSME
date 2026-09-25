-- ACTIVATION_INVITES_SENT: a bulk send of activation links.
--
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
        'USER_PASSWORD_SET_BY_ADMIN','USER_EMAIL_CHANGED_BY_ADMIN',
        'ACCOUNT_ACTIVATED','ACTIVATION_INVITES_SENT'
    ) NOT NULL;
