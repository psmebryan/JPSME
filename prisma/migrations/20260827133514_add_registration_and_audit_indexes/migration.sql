-- CreateIndex
CREATE INDEX `audit_logs_paymentId_idx` ON `audit_logs`(`paymentId`);

-- CreateIndex
CREATE INDEX `EventRegistration_eventId_status_idx` ON `EventRegistration`(`eventId`, `status`);
