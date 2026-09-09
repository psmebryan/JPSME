-- Records a member's role being changed, separately from their status.
--
-- Written by hand rather than generated: "prisma migrate diff" also emits a
-- DROP TABLE for `sessions` (owned by express-mysql-session, so it reads as
-- drift on every diff), and running that would sign out every logged-in user.
--
-- Adding a value to an ENUM rewrites no rows and takes no lock worth worrying
-- about at this table's size.
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
  'USER_ROLE_CHANGED'
) NOT NULL;
