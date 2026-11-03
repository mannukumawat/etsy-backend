-- CreateTable
CREATE TABLE `owners` (
    `id` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `passwordHash` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `owners_email_key`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `media` (
    `id` VARCHAR(191) NOT NULL,
    `fileName` VARCHAR(191) NOT NULL,
    `mimeType` VARCHAR(191) NOT NULL,
    `sizeBytes` INTEGER NOT NULL,
    `width` INTEGER NULL,
    `height` INTEGER NULL,
    `altEn` TEXT NOT NULL,
    `altHi` TEXT NOT NULL,
    `data` LONGBLOB NOT NULL,
    `source` VARCHAR(191) NOT NULL DEFAULT 'seed',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `categories` (
    `id` VARCHAR(191) NOT NULL,
    `slug` VARCHAR(191) NOT NULL,
    `nameEn` VARCHAR(191) NOT NULL,
    `nameHi` VARCHAR(191) NOT NULL DEFAULT '',
    `descriptionEn` TEXT NOT NULL,
    `descriptionHi` TEXT NOT NULL,
    `imageId` VARCHAR(191) NULL,
    `bannerId` VARCHAR(191) NULL,
    `displayOrder` INTEGER NOT NULL DEFAULT 0,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `categories_slug_key`(`slug`),
    INDEX `categories_isActive_displayOrder_idx`(`isActive`, `displayOrder`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `products` (
    `id` VARCHAR(191) NOT NULL,
    `slug` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'draft',
    `nameEn` VARCHAR(191) NOT NULL,
    `nameHi` VARCHAR(191) NOT NULL DEFAULT '',
    `nameSearch` VARCHAR(191) NOT NULL DEFAULT '',
    `shortDescriptionEn` TEXT NOT NULL,
    `shortDescriptionHi` TEXT NOT NULL,
    `descriptionEn` TEXT NOT NULL,
    `descriptionHi` TEXT NOT NULL,
    `categoryId` VARCHAR(191) NOT NULL,
    `tags` TEXT NOT NULL,
    `searchText` TEXT NOT NULL,
    `basePrice` INTEGER NOT NULL,
    `baseSalePrice` INTEGER NULL,
    `materialsEn` TEXT NOT NULL,
    `materialsHi` TEXT NOT NULL,
    `careEn` TEXT NOT NULL,
    `careHi` TEXT NOT NULL,
    `weightValue` DOUBLE NULL,
    `weightUnit` VARCHAR(191) NOT NULL DEFAULT 'g',
    `dimLength` DOUBLE NULL,
    `dimWidth` DOUBLE NULL,
    `dimHeight` DOUBLE NULL,
    `dimUnit` VARCHAR(191) NOT NULL DEFAULT 'cm',
    `isFeatured` BOOLEAN NOT NULL DEFAULT false,
    `isBestseller` BOOLEAN NOT NULL DEFAULT false,
    `isNew` BOOLEAN NOT NULL DEFAULT false,
    `displayOrder` INTEGER NOT NULL DEFAULT 100,
    `seoTitleEn` VARCHAR(191) NOT NULL DEFAULT '',
    `seoTitleHi` VARCHAR(191) NOT NULL DEFAULT '',
    `seoDescriptionEn` TEXT NOT NULL,
    `seoDescriptionHi` TEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `products_slug_key`(`slug`),
    INDEX `products_status_displayOrder_idx`(`status`, `displayOrder`),
    INDEX `products_categoryId_idx`(`categoryId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `product_images` (
    `id` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `mediaId` VARCHAR(191) NOT NULL,
    `position` INTEGER NOT NULL,
    `altEn` VARCHAR(191) NOT NULL DEFAULT '',
    `altHi` VARCHAR(191) NOT NULL DEFAULT '',

    INDEX `product_images_productId_position_idx`(`productId`, `position`),
    UNIQUE INDEX `product_images_productId_mediaId_key`(`productId`, `mediaId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `product_options` (
    `id` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `nameEn` VARCHAR(191) NOT NULL,
    `nameHi` VARCHAR(191) NOT NULL DEFAULT '',
    `type` VARCHAR(191) NOT NULL DEFAULT 'button',
    `position` INTEGER NOT NULL,

    INDEX `product_options_productId_position_idx`(`productId`, `position`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `product_option_values` (
    `id` VARCHAR(191) NOT NULL,
    `optionId` VARCHAR(191) NOT NULL,
    `labelEn` VARCHAR(191) NOT NULL,
    `labelHi` VARCHAR(191) NOT NULL DEFAULT '',
    `swatch` VARCHAR(191) NULL,
    `position` INTEGER NOT NULL,

    INDEX `product_option_values_optionId_position_idx`(`optionId`, `position`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `product_variants` (
    `id` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `sku` VARCHAR(191) NOT NULL,
    `options` TEXT NOT NULL,
    `price` INTEGER NOT NULL,
    `salePrice` INTEGER NULL,
    `stock` INTEGER NOT NULL DEFAULT 0,
    `imageIds` TEXT NOT NULL,
    `position` INTEGER NOT NULL DEFAULT 0,

    UNIQUE INDEX `product_variants_sku_key`(`sku`),
    INDEX `product_variants_productId_position_idx`(`productId`, `position`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `product_specs` (
    `id` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `labelEn` VARCHAR(191) NOT NULL,
    `labelHi` VARCHAR(191) NOT NULL DEFAULT '',
    `valueEn` VARCHAR(191) NOT NULL,
    `valueHi` VARCHAR(191) NOT NULL DEFAULT '',
    `position` INTEGER NOT NULL,

    INDEX `product_specs_productId_position_idx`(`productId`, `position`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `categories` ADD CONSTRAINT `categories_imageId_fkey` FOREIGN KEY (`imageId`) REFERENCES `media`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `categories` ADD CONSTRAINT `categories_bannerId_fkey` FOREIGN KEY (`bannerId`) REFERENCES `media`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `products` ADD CONSTRAINT `products_categoryId_fkey` FOREIGN KEY (`categoryId`) REFERENCES `categories`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `product_images` ADD CONSTRAINT `product_images_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `product_images` ADD CONSTRAINT `product_images_mediaId_fkey` FOREIGN KEY (`mediaId`) REFERENCES `media`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `product_options` ADD CONSTRAINT `product_options_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `product_option_values` ADD CONSTRAINT `product_option_values_optionId_fkey` FOREIGN KEY (`optionId`) REFERENCES `product_options`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `product_variants` ADD CONSTRAINT `product_variants_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `product_specs` ADD CONSTRAINT `product_specs_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

