-- Merchandise store, phase 1: products, variants, photos, the stock ledger and
-- price history (admin -> Merchandise; see the JPSME Merchandise Store Plan).
--
--   merch_products         a product (Polo shirt, Cap, Pin, Lanyard): name,
--                          description, Active switch (hidden from members
--                          until the store opens in a later phase)
--   merch_product_images   up to 6 photos per product, in order
--   merch_variants         what is stocked and sold ("Polo shirt, Navy, L"):
--                          SKU, member and non-member price, unit cost, limit
--                          per buyer, low-stock level. Prices and cost may be
--                          NULL = not decided yet (TBD).
--   merch_stock_movements  the stock ledger. Stock is never typed over: every
--                          change is a signed movement (received, damaged,
--                          count correction; held/sold/released/returned come
--                          with checkout) and on hand = the sum.
--   merch_price_changes    every change to a variant's prices or cost, with
--                          who and when, so nothing is edited silently.
--
-- Guarded so a retry after a partial run is harmless.

CREATE TABLE IF NOT EXISTS `merch_products` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(80) NOT NULL,
  `description` TEXT NULL,
  `isActive` BOOLEAN NOT NULL DEFAULT false,
  `sortOrder` INTEGER NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `merch_products_name_key`(`name`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `merch_product_images` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `productId` INTEGER NOT NULL,
  `url` VARCHAR(500) NOT NULL,
  `sortOrder` INTEGER NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `merch_product_images_productId_idx`(`productId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `merch_variants` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `productId` INTEGER NOT NULL,
  `sku` VARCHAR(40) NOT NULL,
  `label` VARCHAR(80) NOT NULL,
  `size` VARCHAR(20) NULL,
  `color` VARCHAR(30) NULL,
  `memberPriceCentavos` INTEGER NULL,
  `priceCentavos` INTEGER NULL,
  `costCentavos` INTEGER NULL,
  `limitPerBuyer` INTEGER NULL,
  `lowStockLevel` INTEGER NULL,
  `isActive` BOOLEAN NOT NULL DEFAULT true,
  `sortOrder` INTEGER NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `merch_variants_sku_key`(`sku`),
  UNIQUE INDEX `merch_variants_productId_label_key`(`productId`, `label`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `merch_stock_movements` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `variantId` INTEGER NOT NULL,
  `type` VARCHAR(20) NOT NULL,
  `quantity` INTEGER NOT NULL,
  `reason` VARCHAR(300) NULL,
  `supplier` VARCHAR(120) NULL,
  `unitCostCentavos` INTEGER NULL,
  `actorId` INTEGER NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `merch_stock_movements_variantId_idx`(`variantId`),
  INDEX `merch_stock_movements_createdAt_idx`(`createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `merch_price_changes` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `variantId` INTEGER NOT NULL,
  `field` VARCHAR(30) NOT NULL,
  `oldValue` INTEGER NULL,
  `newValue` INTEGER NULL,
  `actorId` INTEGER NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `merch_price_changes_variantId_idx`(`variantId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Foreign keys. Photos and variants go with their product. A variant with
-- stock history cannot be deleted (RESTRICT): it is switched off instead, so
-- the ledger never loses a line. Removing an account keeps its ledger lines
-- (actor set to NULL).
SET @migration_sql = IF(
  (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'merch_product_images' AND CONSTRAINT_NAME = 'merch_product_images_productId_fkey') = 0,
  'ALTER TABLE `merch_product_images` ADD CONSTRAINT `merch_product_images_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `merch_products`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'merch_variants' AND CONSTRAINT_NAME = 'merch_variants_productId_fkey') = 0,
  'ALTER TABLE `merch_variants` ADD CONSTRAINT `merch_variants_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `merch_products`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'merch_stock_movements' AND CONSTRAINT_NAME = 'merch_stock_movements_variantId_fkey') = 0,
  'ALTER TABLE `merch_stock_movements` ADD CONSTRAINT `merch_stock_movements_variantId_fkey` FOREIGN KEY (`variantId`) REFERENCES `merch_variants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'merch_stock_movements' AND CONSTRAINT_NAME = 'merch_stock_movements_actorId_fkey') = 0,
  'ALTER TABLE `merch_stock_movements` ADD CONSTRAINT `merch_stock_movements_actorId_fkey` FOREIGN KEY (`actorId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'merch_price_changes' AND CONSTRAINT_NAME = 'merch_price_changes_variantId_fkey') = 0,
  'ALTER TABLE `merch_price_changes` ADD CONSTRAINT `merch_price_changes_variantId_fkey` FOREIGN KEY (`variantId`) REFERENCES `merch_variants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'merch_price_changes' AND CONSTRAINT_NAME = 'merch_price_changes_actorId_fkey') = 0,
  'ALTER TABLE `merch_price_changes` ADD CONSTRAINT `merch_price_changes_actorId_fkey` FOREIGN KEY (`actorId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;
