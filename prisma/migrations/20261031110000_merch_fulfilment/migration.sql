-- Merchandise store, phase 3a: delivery or pickup, addresses, and fulfilment.
--
--   psgc_areas            the PSA's Philippine Standard Geographic Code list
--                         (regions, provinces, cities/municipalities,
--                         sub-municipalities, barangays), imported from the
--                         PSA publication workbook; feeds the address dropdowns
--   merch_delivery_zones  delivery fee per zone (Metro Manila, rest of Luzon,
--                         Visayas, Mindanao); fee NULL = delivery not offered
--   merch_zone_regions    which zone each region belongs to
--   merch_pickup_points   where orders can be picked up (office, chapter, event)
--   merch_addresses       a buyer's saved delivery addresses
--   merch_order_events    every status change of an order: who, when, note
--   merch_orders          + fulfilment (DELIVERY / PICKUP), delivery fee, the
--                         address or pickup point copied at checkout, courier
--                         and tracking, the pickup QR, and the step times
--
-- Guarded so a retry after a partial run is harmless.

CREATE TABLE IF NOT EXISTS `psgc_areas` (
  `code` CHAR(10) NOT NULL,
  `name` VARCHAR(150) NOT NULL,
  `level` VARCHAR(10) NOT NULL,
  `regionCode` CHAR(10) NOT NULL,
  `provinceCode` CHAR(10) NULL,
  `cityCode` CHAR(10) NULL,
  `subMunicipality` VARCHAR(100) NULL,
  `cityClass` VARCHAR(10) NULL,

  INDEX `psgc_areas_level_regionCode_idx`(`level`, `regionCode`),
  INDEX `psgc_areas_level_provinceCode_idx`(`level`, `provinceCode`),
  INDEX `psgc_areas_level_cityCode_idx`(`level`, `cityCode`),
  PRIMARY KEY (`code`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `merch_delivery_zones` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(60) NOT NULL,
  `feeCentavos` INTEGER NULL,
  `isActive` BOOLEAN NOT NULL DEFAULT true,
  `sortOrder` INTEGER NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `merch_delivery_zones_name_key`(`name`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `merch_zone_regions` (
  `regionCode` CHAR(10) NOT NULL,
  `zoneId` INTEGER NOT NULL,

  INDEX `merch_zone_regions_zoneId_idx`(`zoneId`),
  PRIMARY KEY (`regionCode`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `merch_pickup_points` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(120) NOT NULL,
  `address` VARCHAR(300) NOT NULL,
  `hours` VARCHAR(200) NULL,
  `eventId` INTEGER NULL,
  `endsAt` DATETIME(3) NULL,
  `isActive` BOOLEAN NOT NULL DEFAULT true,
  `sortOrder` INTEGER NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `merch_addresses` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `userId` INTEGER NOT NULL,
  `recipientName` VARCHAR(150) NOT NULL,
  `mobile` VARCHAR(20) NOT NULL,
  `altMobile` VARCHAR(20) NULL,
  `houseNo` VARCHAR(100) NOT NULL,
  `building` VARCHAR(120) NULL,
  `street` VARCHAR(150) NOT NULL,
  `subdivision` VARCHAR(120) NULL,
  `regionCode` CHAR(10) NOT NULL,
  `provinceCode` CHAR(10) NULL,
  `cityCode` CHAR(10) NOT NULL,
  `barangayCode` CHAR(10) NOT NULL,
  `zip` CHAR(4) NOT NULL,
  `landmark` VARCHAR(200) NOT NULL,
  `notes` VARCHAR(300) NULL,
  `addressType` VARCHAR(10) NOT NULL,
  `isDefault` BOOLEAN NOT NULL DEFAULT false,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  INDEX `merch_addresses_userId_idx`(`userId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `merch_order_events` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `orderId` INTEGER NOT NULL,
  `status` VARCHAR(30) NOT NULL,
  `note` VARCHAR(300) NULL,
  `actorId` INTEGER NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `merch_order_events_orderId_idx`(`orderId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'merch_orders' AND COLUMN_NAME = 'fulfilment') = 0,
  'ALTER TABLE `merch_orders` ADD COLUMN `fulfilment` VARCHAR(10) NULL, ADD COLUMN `deliveryFeeCentavos` INTEGER NOT NULL DEFAULT 0, ADD COLUMN `zoneName` VARCHAR(60) NULL, ADD COLUMN `shipTo` TEXT NULL, ADD COLUMN `shipRegionCode` CHAR(10) NULL, ADD COLUMN `pickupPointId` INTEGER NULL, ADD COLUMN `pickupPoint` TEXT NULL, ADD COLUMN `courier` VARCHAR(80) NULL, ADD COLUMN `trackingNumber` VARCHAR(80) NULL, ADD COLUMN `qrToken` VARCHAR(40) NULL, ADD COLUMN `holdFromStatus` VARCHAR(30) NULL, ADD COLUMN `addressNote` VARCHAR(300) NULL, ADD COLUMN `packedAt` DATETIME(3) NULL, ADD COLUMN `shippedAt` DATETIME(3) NULL, ADD COLUMN `deliveredAt` DATETIME(3) NULL, ADD COLUMN `readyAt` DATETIME(3) NULL, ADD COLUMN `pickedUpAt` DATETIME(3) NULL, ADD COLUMN `pickedUpById` INTEGER NULL, ADD COLUMN `pickupReminderAt` DATETIME(3) NULL, ADD UNIQUE INDEX `merch_orders_qrToken_key`(`qrToken`), ADD INDEX `merch_orders_status_idx`(`status`)',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

-- Foreign keys.
SET @migration_sql = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'merch_zone_regions' AND CONSTRAINT_NAME = 'merch_zone_regions_zoneId_fkey') = 0,
  'ALTER TABLE `merch_zone_regions` ADD CONSTRAINT `merch_zone_regions_zoneId_fkey` FOREIGN KEY (`zoneId`) REFERENCES `merch_delivery_zones`(`id`) ON DELETE CASCADE ON UPDATE CASCADE', 'SELECT 1');
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'merch_pickup_points' AND CONSTRAINT_NAME = 'merch_pickup_points_eventId_fkey') = 0,
  'ALTER TABLE `merch_pickup_points` ADD CONSTRAINT `merch_pickup_points_eventId_fkey` FOREIGN KEY (`eventId`) REFERENCES `Event`(`id`) ON DELETE SET NULL ON UPDATE CASCADE', 'SELECT 1');
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'merch_addresses' AND CONSTRAINT_NAME = 'merch_addresses_userId_fkey') = 0,
  'ALTER TABLE `merch_addresses` ADD CONSTRAINT `merch_addresses_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE', 'SELECT 1');
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'merch_order_events' AND CONSTRAINT_NAME = 'merch_order_events_orderId_fkey') = 0,
  'ALTER TABLE `merch_order_events` ADD CONSTRAINT `merch_order_events_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `merch_orders`(`id`) ON DELETE CASCADE ON UPDATE CASCADE', 'SELECT 1');
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

SET @migration_sql = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'merch_order_events' AND CONSTRAINT_NAME = 'merch_order_events_actorId_fkey') = 0,
  'ALTER TABLE `merch_order_events` ADD CONSTRAINT `merch_order_events_actorId_fkey` FOREIGN KEY (`actorId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE', 'SELECT 1');
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

-- The four zones from the plan, with no fee yet (delivery is offered once a
-- fee is set), and each region's zone. Region codes are the PSA's 10-digit
-- region codes. INSERT IGNORE: a re-run never duplicates or overwrites.
INSERT IGNORE INTO `merch_delivery_zones` (`name`, `feeCentavos`, `isActive`, `sortOrder`, `updatedAt`) VALUES
  ('Metro Manila', NULL, true, 0, CURRENT_TIMESTAMP(3)),
  ('Rest of Luzon', NULL, true, 1, CURRENT_TIMESTAMP(3)),
  ('Visayas', NULL, true, 2, CURRENT_TIMESTAMP(3)),
  ('Mindanao', NULL, true, 3, CURRENT_TIMESTAMP(3));

INSERT IGNORE INTO `merch_zone_regions` (`regionCode`, `zoneId`)
SELECT r.code, z.id FROM (
  SELECT '1300000000' AS code, 'Metro Manila' AS zone UNION ALL
  SELECT '1400000000', 'Rest of Luzon' UNION ALL SELECT '0100000000', 'Rest of Luzon' UNION ALL
  SELECT '0200000000', 'Rest of Luzon' UNION ALL SELECT '0300000000', 'Rest of Luzon' UNION ALL
  SELECT '0400000000', 'Rest of Luzon' UNION ALL SELECT '1700000000', 'Rest of Luzon' UNION ALL
  SELECT '0500000000', 'Rest of Luzon' UNION ALL
  SELECT '0600000000', 'Visayas' UNION ALL SELECT '1800000000', 'Visayas' UNION ALL
  SELECT '0700000000', 'Visayas' UNION ALL SELECT '0800000000', 'Visayas' UNION ALL
  SELECT '0900000000', 'Mindanao' UNION ALL SELECT '1000000000', 'Mindanao' UNION ALL
  SELECT '1100000000', 'Mindanao' UNION ALL SELECT '1200000000', 'Mindanao' UNION ALL
  SELECT '1600000000', 'Mindanao' UNION ALL SELECT '1900000000', 'Mindanao'
) r JOIN `merch_delivery_zones` z ON z.name = r.zone;
