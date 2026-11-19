-- Merchandise store, phase 2: cart, orders and checkout through PayMongo.
--
--   payments.purpose        + MERCHANDISE, beside membership and event fees
--   refunds.requestedBy     may be NULL = requested by the system (the
--                           automatic refund when stock sold out before a late
--                           payment arrived)
--   merch_cart_items        a member's cart, one line per variant
--   merch_orders            an order: who, status, totals, its payment, and
--                           when its 30-minute stock hold runs out
--   merch_order_items       what was bought, with name, SKU, price and cost
--                           copied at the moment of purchase
--   merch_stock_movements   + orderId, so holds and sales point at their order
--
-- Guarded so a retry after a partial run is harmless.

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payments' AND COLUMN_NAME = 'purpose'
     AND COLUMN_TYPE LIKE '%MERCHANDISE%') = 0,
  'ALTER TABLE `payments` MODIFY `purpose` ENUM(''MEMBERSHIP_REGISTRATION'', ''EVENT_REGISTRATION'', ''MERCHANDISE'') NOT NULL DEFAULT ''MEMBERSHIP_REGISTRATION''',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'refunds' AND COLUMN_NAME = 'requestedBy' AND IS_NULLABLE = 'NO') = 1,
  'ALTER TABLE `refunds` MODIFY `requestedBy` INTEGER NULL',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

CREATE TABLE IF NOT EXISTS `merch_cart_items` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `userId` INTEGER NOT NULL,
  `variantId` INTEGER NOT NULL,
  `quantity` INTEGER NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `merch_cart_items_userId_variantId_key`(`userId`, `variantId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `merch_orders` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `orderNumber` VARCHAR(30) NULL,
  `userId` INTEGER NULL,
  `buyerName` VARCHAR(200) NOT NULL,
  `buyerEmail` VARCHAR(191) NOT NULL,
  `organizationId` INTEGER NULL,
  `memberPricing` BOOLEAN NOT NULL DEFAULT false,
  `status` VARCHAR(30) NOT NULL,
  `subtotalCentavos` INTEGER NOT NULL,
  `channelFeeCentavos` INTEGER NOT NULL DEFAULT 0,
  `totalCentavos` INTEGER NOT NULL,
  `paymentId` INTEGER NULL,
  `holdExpiresAt` DATETIME(3) NULL,
  `paidAt` DATETIME(3) NULL,
  `cancelledAt` DATETIME(3) NULL,
  `cancelReason` VARCHAR(200) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `merch_orders_orderNumber_key`(`orderNumber`),
  UNIQUE INDEX `merch_orders_paymentId_key`(`paymentId`),
  INDEX `merch_orders_userId_idx`(`userId`),
  INDEX `merch_orders_status_holdExpiresAt_idx`(`status`, `holdExpiresAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `merch_order_items` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `orderId` INTEGER NOT NULL,
  `variantId` INTEGER NOT NULL,
  `productName` VARCHAR(80) NOT NULL,
  `variantLabel` VARCHAR(80) NOT NULL,
  `sku` VARCHAR(40) NOT NULL,
  `priceType` VARCHAR(10) NOT NULL,
  `unitPriceCentavos` INTEGER NOT NULL,
  `unitCostCentavos` INTEGER NULL,
  `quantity` INTEGER NOT NULL,

  INDEX `merch_order_items_orderId_idx`(`orderId`),
  INDEX `merch_order_items_variantId_idx`(`variantId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'merch_stock_movements' AND COLUMN_NAME = 'orderId') = 0,
  'ALTER TABLE `merch_stock_movements` ADD COLUMN `orderId` INTEGER NULL, ADD INDEX `merch_stock_movements_orderId_idx`(`orderId`)',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

-- Foreign keys. A cart line goes with its account or variant. An order keeps
-- its money record if the account is removed (userId set NULL; the buyer's
-- name and email are copied on the order). Items go with their order; a
-- variant that was sold cannot be deleted. A payment row is never deleted.
SET @migration_sql = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'merch_cart_items' AND CONSTRAINT_NAME = 'merch_cart_items_userId_fkey') = 0,
  'ALTER TABLE `merch_cart_items` ADD CONSTRAINT `merch_cart_items_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE', 'SELECT 1');
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'merch_cart_items' AND CONSTRAINT_NAME = 'merch_cart_items_variantId_fkey') = 0,
  'ALTER TABLE `merch_cart_items` ADD CONSTRAINT `merch_cart_items_variantId_fkey` FOREIGN KEY (`variantId`) REFERENCES `merch_variants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE', 'SELECT 1');
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'merch_orders' AND CONSTRAINT_NAME = 'merch_orders_userId_fkey') = 0,
  'ALTER TABLE `merch_orders` ADD CONSTRAINT `merch_orders_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE', 'SELECT 1');
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'merch_orders' AND CONSTRAINT_NAME = 'merch_orders_paymentId_fkey') = 0,
  'ALTER TABLE `merch_orders` ADD CONSTRAINT `merch_orders_paymentId_fkey` FOREIGN KEY (`paymentId`) REFERENCES `payments`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE', 'SELECT 1');
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'merch_order_items' AND CONSTRAINT_NAME = 'merch_order_items_orderId_fkey') = 0,
  'ALTER TABLE `merch_order_items` ADD CONSTRAINT `merch_order_items_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `merch_orders`(`id`) ON DELETE CASCADE ON UPDATE CASCADE', 'SELECT 1');
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'merch_order_items' AND CONSTRAINT_NAME = 'merch_order_items_variantId_fkey') = 0,
  'ALTER TABLE `merch_order_items` ADD CONSTRAINT `merch_order_items_variantId_fkey` FOREIGN KEY (`variantId`) REFERENCES `merch_variants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE', 'SELECT 1');
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'merch_stock_movements' AND CONSTRAINT_NAME = 'merch_stock_movements_orderId_fkey') = 0,
  'ALTER TABLE `merch_stock_movements` ADD CONSTRAINT `merch_stock_movements_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `merch_orders`(`id`) ON DELETE SET NULL ON UPDATE CASCADE', 'SELECT 1');
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;
