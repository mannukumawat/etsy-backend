-- Add itemGroupId and navLinkId to products, and create item_groups table.
-- NavLink already exists; we just add the FK on products and the products relation.

CREATE TABLE `item_groups` (
    `id`        VARCHAR(191) NOT NULL,
    `nameEn`    VARCHAR(191) NOT NULL,
    `nameHi`    VARCHAR(191) NOT NULL DEFAULT '',
    `slug`      VARCHAR(191) NOT NULL,
    `position`  INTEGER NOT NULL DEFAULT 100,
    `isActive`  BOOLEAN NOT NULL DEFAULT true,
    `imageId`   VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `item_groups_slug_key`(`slug`),
    INDEX `item_groups_isActive_position_idx`(`isActive`, `position`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `products`
    ADD COLUMN `itemGroupId` VARCHAR(191) NULL,
    ADD COLUMN `navLinkId`   VARCHAR(191) NULL;

ALTER TABLE `products`
    ADD INDEX `products_itemGroupId_idx`(`itemGroupId`),
    ADD INDEX `products_navLinkId_idx`(`navLinkId`);

ALTER TABLE `products`
    ADD CONSTRAINT `products_itemGroupId_fkey`
        FOREIGN KEY (`itemGroupId`) REFERENCES `item_groups`(`id`)
        ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `products`
    ADD CONSTRAINT `products_navLinkId_fkey`
        FOREIGN KEY (`navLinkId`) REFERENCES `nav_links`(`id`)
        ON DELETE SET NULL ON UPDATE CASCADE;
