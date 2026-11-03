-- CreateTable
CREATE TABLE `nav_links` (
    `id` VARCHAR(191) NOT NULL,
    `labelEn` VARCHAR(191) NOT NULL,
    `labelHi` VARCHAR(191) NOT NULL DEFAULT '',
    `href` VARCHAR(191) NOT NULL,
    `position` INTEGER NOT NULL DEFAULT 0,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `collections` (
    `id` VARCHAR(191) NOT NULL,
    `slug` VARCHAR(191) NOT NULL,
    `titleEn` VARCHAR(191) NOT NULL,
    `titleHi` VARCHAR(191) NOT NULL DEFAULT '',
    `subtitleEn` TEXT NOT NULL DEFAULT '',
    `subtitleHi` TEXT NOT NULL DEFAULT '',
    `descriptionEn` TEXT NOT NULL DEFAULT '',
    `descriptionHi` TEXT NOT NULL DEFAULT '',
    `heroImageId` VARCHAR(191) NULL,
    `heroColor` VARCHAR(191) NOT NULL DEFAULT '#F5ECE1',
    `status` VARCHAR(191) NOT NULL DEFAULT 'draft',
    `displayOrder` INTEGER NOT NULL DEFAULT 0,
    `publishedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `collections_slug_key`(`slug`),
    INDEX `collections_status_displayOrder_idx`(`status`, `displayOrder`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `collection_circles` (
    `id` VARCHAR(191) NOT NULL,
    `collectionId` VARCHAR(191) NOT NULL,
    `labelEn` VARCHAR(191) NOT NULL,
    `labelHi` VARCHAR(191) NOT NULL DEFAULT '',
    `imageId` VARCHAR(191) NULL,
    `linkType` VARCHAR(191) NOT NULL,
    `linkValue` VARCHAR(191) NOT NULL,
    `position` INTEGER NOT NULL DEFAULT 0,

    INDEX `collection_circles_collectionId_position_idx`(`collectionId`, `position`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `collection_sections` (
    `id` VARCHAR(191) NOT NULL,
    `collectionId` VARCHAR(191) NOT NULL,
    `titleEn` VARCHAR(191) NOT NULL,
    `titleHi` VARCHAR(191) NOT NULL DEFAULT '',
    `position` INTEGER NOT NULL DEFAULT 0,
    `productIds` TEXT NOT NULL DEFAULT '[]',

    INDEX `collection_sections_collectionId_position_idx`(`collectionId`, `position`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `collections` ADD CONSTRAINT `collections_heroImageId_fkey` FOREIGN KEY (`heroImageId`) REFERENCES `media`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `collection_circles` ADD CONSTRAINT `collection_circles_collectionId_fkey` FOREIGN KEY (`collectionId`) REFERENCES `collections`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `collection_circles` ADD CONSTRAINT `collection_circles_imageId_fkey` FOREIGN KEY (`imageId`) REFERENCES `media`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `collection_sections` ADD CONSTRAINT `collection_sections_collectionId_fkey` FOREIGN KEY (`collectionId`) REFERENCES `collections`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
