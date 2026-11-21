-- Medium findings (M-P1, M-S2): product barcode / cost price / collection assignment,
-- and a free-shipping order-value threshold on shipping settings.
ALTER TABLE `products` ADD COLUMN `barcode` VARCHAR(191) NULL;
ALTER TABLE `products` ADD COLUMN `costPrice` INT NULL;
ALTER TABLE `products` ADD COLUMN `collectionId` VARCHAR(191) NULL;
ALTER TABLE `products` ADD CONSTRAINT `products_collectionId_fkey` FOREIGN KEY (`collectionId`) REFERENCES `collections` (`id`) ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX `products_collectionId_idx` ON `products` (`collectionId`);

ALTER TABLE `shipping_settings` ADD COLUMN `freeShippingThreshold` INT NULL;
