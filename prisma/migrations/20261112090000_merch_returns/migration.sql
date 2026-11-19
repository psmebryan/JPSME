-- Merchandise store, phase 3b: refunds and exchanges.
--
--   merch_returns          one request on an order: a REFUND or an EXCHANGE,
--                          its reason, the buyer's photo, who asked, the
--                          Logistics check, the approvals (a second one above
--                          the approval limit), the refund it produced, and
--                          for an exchange how the new item went out
--   merch_return_items     which order lines, how many, the new variant for an
--                          exchange, and how many came back / can be resold
--   merch_stock_movements  + returnId: an exchange's hold, sale and returns
--                          point at the request, not at the order
--
-- Guarded so a retry after a partial run is harmless.

CREATE TABLE IF NOT EXISTS `merch_returns` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `returnNumber` VARCHAR(30) NULL,
  `orderId` INTEGER NOT NULL,
  `kind` VARCHAR(10) NOT NULL,
  `status` VARCHAR(30) NOT NULL,
  `reason` VARCHAR(30) NOT NULL,
  `details` VARCHAR(1000) NULL,
  `photoUrl` VARCHAR(500) NULL,
  `requestedById` INTEGER NULL,
  `byBuyer` BOOLEAN NOT NULL DEFAULT true,
  `noItemBack` BOOLEAN NOT NULL DEFAULT false,
  `checkedById` INTEGER NULL,
  `checkedAt` DATETIME(3) NULL,
  `checkNote` VARCHAR(300) NULL,
  `suggestedCentavos` INTEGER NULL,
  `refundCentavos` INTEGER NULL,
  `approvedById` INTEGER NULL,
  `approvedAt` DATETIME(3) NULL,
  `secondApprovedById` INTEGER NULL,
  `secondApprovedAt` DATETIME(3) NULL,
  `rejectReason` VARCHAR(300) NULL,
  `refundId` INTEGER NULL,
  `courier` VARCHAR(80) NULL,
  `trackingNumber` VARCHAR(80) NULL,
  `completedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `merch_returns_returnNumber_key`(`returnNumber`),
  INDEX `merch_returns_orderId_idx`(`orderId`),
  INDEX `merch_returns_status_idx`(`status`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `merch_return_items` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `returnId` INTEGER NOT NULL,
  `orderItemId` INTEGER NOT NULL,
  `quantity` INTEGER NOT NULL,
  `newVariantId` INTEGER NULL,
  `receivedQty` INTEGER NULL,
  `resaleableQty` INTEGER NULL,

  INDEX `merch_return_items_returnId_idx`(`returnId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'merch_stock_movements' AND COLUMN_NAME = 'returnId') = 0,
  'ALTER TABLE `merch_stock_movements` ADD COLUMN `returnId` INTEGER NULL, ADD INDEX `merch_stock_movements_returnId_idx`(`returnId`)',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

-- Foreign keys. A request belongs to its order. People who acted on it may be
-- removed later without losing the record (SET NULL). An order line or
-- variant a request points at cannot be deleted from under it.
SET @migration_sql = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'merch_returns' AND CONSTRAINT_NAME = 'merch_returns_orderId_fkey') = 0,
  'ALTER TABLE `merch_returns` ADD CONSTRAINT `merch_returns_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `merch_orders`(`id`) ON DELETE CASCADE ON UPDATE CASCADE', 'SELECT 1');
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'merch_returns' AND CONSTRAINT_NAME = 'merch_returns_requestedById_fkey') = 0,
  'ALTER TABLE `merch_returns` ADD CONSTRAINT `merch_returns_requestedById_fkey` FOREIGN KEY (`requestedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE', 'SELECT 1');
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'merch_return_items' AND CONSTRAINT_NAME = 'merch_return_items_returnId_fkey') = 0,
  'ALTER TABLE `merch_return_items` ADD CONSTRAINT `merch_return_items_returnId_fkey` FOREIGN KEY (`returnId`) REFERENCES `merch_returns`(`id`) ON DELETE CASCADE ON UPDATE CASCADE', 'SELECT 1');
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'merch_return_items' AND CONSTRAINT_NAME = 'merch_return_items_orderItemId_fkey') = 0,
  'ALTER TABLE `merch_return_items` ADD CONSTRAINT `merch_return_items_orderItemId_fkey` FOREIGN KEY (`orderItemId`) REFERENCES `merch_order_items`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE', 'SELECT 1');
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'merch_return_items' AND CONSTRAINT_NAME = 'merch_return_items_newVariantId_fkey') = 0,
  'ALTER TABLE `merch_return_items` ADD CONSTRAINT `merch_return_items_newVariantId_fkey` FOREIGN KEY (`newVariantId`) REFERENCES `merch_variants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE', 'SELECT 1');
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'merch_stock_movements' AND CONSTRAINT_NAME = 'merch_stock_movements_returnId_fkey') = 0,
  'ALTER TABLE `merch_stock_movements` ADD CONSTRAINT `merch_stock_movements_returnId_fkey` FOREIGN KEY (`returnId`) REFERENCES `merch_returns`(`id`) ON DELETE SET NULL ON UPDATE CASCADE', 'SELECT 1');
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;
