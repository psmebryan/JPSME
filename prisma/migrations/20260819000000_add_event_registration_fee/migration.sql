-- AlterTable
ALTER TABLE `audit_logs` MODIFY `action` ENUM('PAYMENT_CREATED', 'PAYMENT_PROCESSING', 'PAYMENT_SUCCEEDED', 'PAYMENT_FAILED', 'WEBHOOK_RECEIVED', 'WEBHOOK_REJECTED', 'WEBHOOK_DUPLICATE', 'REFUND_REQUESTED', 'REFUND_SUCCEEDED', 'REFUND_FAILED', 'UNAUTHORIZED_PAYMENT_ACCESS', 'SUSPICIOUS_PAYMENT_MISMATCH', 'PAYMENT_RECONCILED') NOT NULL;

-- AlterTable
ALTER TABLE `event` ADD COLUMN `feeCentavos` INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `eventregistration` MODIFY `status` ENUM('REGISTERED', 'PENDING_PAYMENT', 'CANCELLED') NOT NULL DEFAULT 'REGISTERED';

-- AlterTable
ALTER TABLE `payments` ADD COLUMN `eventId` INTEGER NULL,
    MODIFY `purpose` ENUM('MEMBERSHIP_REGISTRATION', 'EVENT_REGISTRATION') NOT NULL DEFAULT 'MEMBERSHIP_REGISTRATION';

-- CreateIndex
CREATE INDEX `payments_eventId_idx` ON `payments`(`eventId`);

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_eventId_fkey` FOREIGN KEY (`eventId`) REFERENCES `Event`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-added financial invariant (MariaDB 10.4.32 confirmed enforcing CHECK
-- constraints, unlike pre-8.0.16 MySQL): a payment can never be marked PAID
-- without a gateway payment id and a paid timestamp recorded in the same
-- write. This is a single-table invariant; cross-table ones (e.g. a REFUNDED
-- payment must have a matching Refund row) are enforced at the application
-- choke points instead (payment.service.js) and covered by the test plan.
ALTER TABLE `payments` ADD CONSTRAINT `chk_paid_has_gateway_id`
  CHECK (`status` <> 'PAID' OR (`gatewayPaymentId` IS NOT NULL AND `paidAt` IS NOT NULL));
