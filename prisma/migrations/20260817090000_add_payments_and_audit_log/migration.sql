
-- CreateTable
CREATE TABLE `payments` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `purpose` ENUM('MEMBERSHIP_REGISTRATION') NOT NULL DEFAULT 'MEMBERSHIP_REGISTRATION',
    `gateway` VARCHAR(191) NOT NULL DEFAULT 'paymongo',
    `gatewayCheckoutId` VARCHAR(191) NULL,
    `gatewayPaymentId` VARCHAR(191) NULL,
    `amount` INTEGER NOT NULL,
    `currency` VARCHAR(191) NOT NULL DEFAULT 'PHP',
    `status` ENUM('PENDING', 'PROCESSING', 'PAID', 'FAILED', 'EXPIRED', 'CANCELLED', 'REFUNDED') NOT NULL DEFAULT 'PENDING',
    `expiresAt` DATETIME(3) NULL,
    `paidAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `payments_gatewayCheckoutId_key`(`gatewayCheckoutId`),
    UNIQUE INDEX `payments_gatewayPaymentId_key`(`gatewayPaymentId`),
    INDEX `payments_userId_idx`(`userId`),
    INDEX `payments_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payment_attempts` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `paymentId` INTEGER NOT NULL,
    `attemptNumber` INTEGER NOT NULL,
    `gatewayReference` VARCHAR(191) NULL,
    `status` ENUM('CREATED', 'AWAITING_PAYMENT', 'SUCCEEDED', 'FAILED') NOT NULL DEFAULT 'CREATED',
    `failureCode` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `payment_attempts_paymentId_attemptNumber_key`(`paymentId`, `attemptNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payment_webhooks` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `gateway` VARCHAR(191) NOT NULL DEFAULT 'paymongo',
    `webhookId` VARCHAR(191) NOT NULL,
    `eventType` VARCHAR(191) NOT NULL,
    `paymentId` INTEGER NULL,
    `payload` TEXT NOT NULL,
    `processed` BOOLEAN NOT NULL DEFAULT false,
    `processedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `payment_webhooks_gateway_webhookId_key`(`gateway`, `webhookId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `refunds` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `paymentId` INTEGER NOT NULL,
    `requestedBy` INTEGER NOT NULL,
    `reason` TEXT NULL,
    `amount` INTEGER NOT NULL,
    `gatewayRefundId` VARCHAR(191) NULL,
    `status` ENUM('REQUESTED', 'PROCESSING', 'SUCCEEDED', 'FAILED') NOT NULL DEFAULT 'REQUESTED',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `refunds_paymentId_key`(`paymentId`),
    UNIQUE INDEX `refunds_gatewayRefundId_key`(`gatewayRefundId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `audit_logs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `action` ENUM('PAYMENT_CREATED', 'PAYMENT_PROCESSING', 'PAYMENT_SUCCEEDED', 'PAYMENT_FAILED', 'WEBHOOK_RECEIVED', 'WEBHOOK_REJECTED', 'WEBHOOK_DUPLICATE', 'REFUND_REQUESTED', 'REFUND_SUCCEEDED', 'REFUND_FAILED', 'UNAUTHORIZED_PAYMENT_ACCESS', 'SUSPICIOUS_PAYMENT_MISMATCH') NOT NULL,
    `actorId` INTEGER NULL,
    `targetUserId` INTEGER NULL,
    `paymentId` INTEGER NULL,
    `metadata` TEXT NULL,
    `ipAddress` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `audit_logs_action_idx`(`action`),
    INDEX `audit_logs_actorId_idx`(`actorId`),
    INDEX `audit_logs_targetUserId_idx`(`targetUserId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_attempts` ADD CONSTRAINT `payment_attempts_paymentId_fkey` FOREIGN KEY (`paymentId`) REFERENCES `payments`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_webhooks` ADD CONSTRAINT `payment_webhooks_paymentId_fkey` FOREIGN KEY (`paymentId`) REFERENCES `payments`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `refunds` ADD CONSTRAINT `refunds_paymentId_fkey` FOREIGN KEY (`paymentId`) REFERENCES `payments`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `refunds` ADD CONSTRAINT `refunds_requestedBy_fkey` FOREIGN KEY (`requestedBy`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `audit_logs` ADD CONSTRAINT `audit_logs_actorId_fkey` FOREIGN KEY (`actorId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `audit_logs` ADD CONSTRAINT `audit_logs_targetUserId_fkey` FOREIGN KEY (`targetUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

