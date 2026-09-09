-- Removing a check-in: the wrong person scanned, one code presented by two
-- people, someone admitted before staff spotted a problem.
--
-- Two enum values, no data change. The reversal is recorded as a new row
-- (action CHECK_OUT, result UNDONE) rather than by deleting the SUCCESS row it
-- undoes -- the admission really did happen, and a door log that loses it can
-- no longer answer "who let them in, and who took it back".
--
-- Written by hand rather than generated: "prisma migrate diff" also emits a
-- DROP TABLE for `sessions` (owned by express-mysql-session, so it reads as
-- drift on every diff), and running that would sign out every logged-in user.
--
-- Appending to an ENUM rewrites no rows and takes no lock worth worrying about
-- at these tables' sizes.
ALTER TABLE `event_check_ins` MODIFY `result` ENUM(
  'SUCCESS',
  'ALREADY_CHECKED_IN',
  'INVALID_QR',
  'WRONG_EVENT',
  'NOT_REGISTERED',
  'CANCELLED',
  'UNPAID',
  'REJECTED',
  'UNDONE'
) NOT NULL;

ALTER TABLE `audit_logs` MODIFY `action` ENUM(
  'PAYMENT_CREATED',
  'PAYMENT_PROCESSING',
  'PAYMENT_SUCCEEDED',
  'PAYMENT_FAILED',
  'WEBHOOK_RECEIVED',
  'WEBHOOK_REJECTED',
  'WEBHOOK_DUPLICATE',
  'REFUND_REQUESTED',
  'REFUND_SUCCEEDED',
  'REFUND_FAILED',
  'UNAUTHORIZED_PAYMENT_ACCESS',
  'SUSPICIOUS_PAYMENT_MISMATCH',
  'PAYMENT_RECONCILED',
  'USER_STATUS_CHANGED',
  'AUTO_APPROVAL_FAILED',
  'QR_GENERATED',
  'QR_REGENERATED',
  'CHECKIN_ACCESS_GRANTED',
  'CHECKIN_ACCESS_REVOKED',
  'USER_ROLE_CHANGED',
  'CHECKIN_UNDONE'
) NOT NULL;
