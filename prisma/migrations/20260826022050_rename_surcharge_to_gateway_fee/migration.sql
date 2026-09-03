-- AlterTable
ALTER TABLE `payments` DROP COLUMN `gatewaySurchargeCentavos`,
    ADD COLUMN `gatewayFeeCentavos` INTEGER NOT NULL DEFAULT 0;
