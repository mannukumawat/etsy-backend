-- CreateTable
CREATE TABLE `store_settings` (
    `id` VARCHAR(191) NOT NULL DEFAULT 'singleton',
    `nameEn` VARCHAR(191) NOT NULL DEFAULT 'Your Store',
    `taglineEn` TEXT NOT NULL,
    `taglineHi` TEXT NOT NULL,
    `logoId` VARCHAR(191) NULL,
    `contactEmail` VARCHAR(191) NOT NULL DEFAULT '',
    `contactPhone` VARCHAR(191) NOT NULL DEFAULT '',
    `contactAddress` TEXT NOT NULL,
    `contactHoursEn` TEXT NOT NULL,
    `contactHoursHi` TEXT NOT NULL,
    `socialInstagram` VARCHAR(191) NOT NULL DEFAULT '',
    `socialPinterest` VARCHAR(191) NOT NULL DEFAULT '',
    `socialFacebook` VARCHAR(191) NOT NULL DEFAULT '',
    `socialYoutube` VARCHAR(191) NOT NULL DEFAULT '',
    `handlingMinDays` INTEGER NOT NULL DEFAULT 1,
    `handlingMaxDays` INTEGER NOT NULL DEFAULT 3,
    `maxQtyPerLine` INTEGER NOT NULL DEFAULT 10,
    `lowStockThreshold` INTEGER NOT NULL DEFAULT 5,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `shipping_settings` (
    `id` VARCHAR(191) NOT NULL DEFAULT 'singleton',
    `unsupportedMessageEn` TEXT NOT NULL,
    `unsupportedMessageHi` TEXT NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `shipping_zones` (
    `id` VARCHAR(191) NOT NULL,
    `settingsId` VARCHAR(191) NOT NULL DEFAULT 'singleton',
    `nameEn` VARCHAR(191) NOT NULL,
    `countries` TEXT NOT NULL,
    `standardEnabled` BOOLEAN NOT NULL DEFAULT true,
    `standardRate` INTEGER NOT NULL DEFAULT 0,
    `standardMinDays` INTEGER NOT NULL DEFAULT 3,
    `standardMaxDays` INTEGER NOT NULL DEFAULT 6,
    `expressEnabled` BOOLEAN NOT NULL DEFAULT false,
    `expressRate` INTEGER NOT NULL DEFAULT 0,
    `expressMinDays` INTEGER NOT NULL DEFAULT 1,
    `expressMaxDays` INTEGER NOT NULL DEFAULT 3,
    `position` INTEGER NOT NULL DEFAULT 0,

    INDEX `shipping_zones_settingsId_position_idx`(`settingsId`, `position`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `tax_settings` (
    `id` VARCHAR(191) NOT NULL DEFAULT 'singleton',
    `pricesIncludeTax` BOOLEAN NOT NULL DEFAULT false,
    `defaultRate` DOUBLE NOT NULL DEFAULT 0,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `tax_rules` (
    `id` VARCHAR(191) NOT NULL,
    `settingsId` VARCHAR(191) NOT NULL DEFAULT 'singleton',
    `country` VARCHAR(191) NOT NULL,
    `region` VARCHAR(191) NOT NULL DEFAULT '',
    `rate` DOUBLE NOT NULL,
    `label` VARCHAR(191) NOT NULL,

    UNIQUE INDEX `tax_rules_settingsId_country_region_key`(`settingsId`, `country`, `region`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `currency_settings` (
    `id` VARCHAR(191) NOT NULL DEFAULT 'singleton',
    `base` VARCHAR(191) NOT NULL DEFAULT 'USD',
    `ratesUpdatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `currency_configs` (
    `id` VARCHAR(191) NOT NULL,
    `settingsId` VARCHAR(191) NOT NULL DEFAULT 'singleton',
    `code` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `rate` DOUBLE NOT NULL,
    `fractionDigits` INTEGER NOT NULL DEFAULT 2,
    `roundingIncrement` INTEGER NOT NULL DEFAULT 1,

    UNIQUE INDEX `currency_configs_settingsId_code_key`(`settingsId`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `language_settings` (
    `id` VARCHAR(191) NOT NULL DEFAULT 'singleton',
    `defaultLanguage` VARCHAR(191) NOT NULL DEFAULT 'en',
    `hindiEnabled` BOOLEAN NOT NULL DEFAULT true,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `inventory_adjustments` (
    `id` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `variantId` VARCHAR(191) NOT NULL,
    `sku` VARCHAR(191) NOT NULL,
    `productNameEn` VARCHAR(191) NOT NULL,
    `productNameHi` VARCHAR(191) NOT NULL DEFAULT '',
    `variantLabel` VARCHAR(191) NOT NULL DEFAULT '',
    `before` INTEGER NOT NULL,
    `after` INTEGER NOT NULL,
    `delta` INTEGER NOT NULL,
    `reason` VARCHAR(191) NOT NULL,
    `note` TEXT NOT NULL,
    `actor` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `inventory_adjustments_variantId_createdAt_idx`(`variantId`, `createdAt`),
    INDEX `inventory_adjustments_productId_idx`(`productId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `homepage_content` (
    `id` VARCHAR(191) NOT NULL DEFAULT 'singleton',
    `draftJson` TEXT NOT NULL,
    `publishedJson` TEXT NULL,
    `publishedAt` DATETIME(3) NULL,
    `updatedAt` DATETIME(3) NOT NULL,
    `updatedBy` VARCHAR(191) NOT NULL DEFAULT '',

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `page_docs` (
    `key` VARCHAR(191) NOT NULL,
    `isLegal` BOOLEAN NOT NULL DEFAULT false,
    `draftJson` TEXT NOT NULL,
    `publishedJson` TEXT NULL,
    `publishedAt` DATETIME(3) NULL,
    `updatedAt` DATETIME(3) NOT NULL,
    `updatedBy` VARCHAR(191) NOT NULL DEFAULT '',

    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `coupons` (
    `id` VARCHAR(191) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `description` TEXT NOT NULL,
    `type` VARCHAR(191) NOT NULL,
    `value` DOUBLE NOT NULL,
    `maxDiscount` INTEGER NULL,
    `minOrder` INTEGER NULL,
    `startsAt` DATETIME(3) NULL,
    `endsAt` DATETIME(3) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `usageLimit` INTEGER NULL,
    `perCustomerLimit` INTEGER NULL,
    `timesUsed` INTEGER NOT NULL DEFAULT 0,
    `scope` VARCHAR(191) NOT NULL DEFAULT 'all',
    `productIds` TEXT NOT NULL,
    `categoryIds` TEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `coupons_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `coupon_redemptions` (
    `id` VARCHAR(191) NOT NULL,
    `couponId` VARCHAR(191) NOT NULL,
    `customerKey` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `coupon_redemptions_couponId_customerKey_idx`(`couponId`, `customerKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `customers` (
    `id` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `passwordHash` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NOT NULL DEFAULT '',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `customers_email_key`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `customer_addresses` (
    `id` VARCHAR(191) NOT NULL,
    `customerId` VARCHAR(191) NOT NULL,
    `label` VARCHAR(191) NOT NULL DEFAULT 'Address',
    `isDefault` BOOLEAN NOT NULL DEFAULT false,
    `fullName` VARCHAR(191) NOT NULL,
    `phoneCountry` VARCHAR(191) NOT NULL DEFAULT '',
    `phone` VARCHAR(191) NOT NULL,
    `country` VARCHAR(191) NOT NULL,
    `line1` VARCHAR(191) NOT NULL,
    `line2` VARCHAR(191) NOT NULL DEFAULT '',
    `city` VARCHAR(191) NOT NULL DEFAULT '',
    `region` VARCHAR(191) NOT NULL DEFAULT '',
    `postalCode` VARCHAR(191) NOT NULL DEFAULT '',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `customer_addresses_customerId_idx`(`customerId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `wishlist_items` (
    `id` VARCHAR(191) NOT NULL,
    `customerId` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `variantId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `wishlist_items_customerId_idx`(`customerId`),
    UNIQUE INDEX `wishlist_items_customerId_productId_variantId_key`(`customerId`, `productId`, `variantId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `password_reset_tokens` (
    `id` VARCHAR(191) NOT NULL,
    `customerId` VARCHAR(191) NOT NULL,
    `tokenHash` VARCHAR(191) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `usedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `password_reset_tokens_tokenHash_key`(`tokenHash`),
    INDEX `password_reset_tokens_customerId_idx`(`customerId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `orders` (
    `id` VARCHAR(191) NOT NULL,
    `number` VARCHAR(191) NOT NULL,
    `idempotencyKey` VARCHAR(191) NULL,
    `customerId` VARCHAR(191) NULL,
    `customerKind` VARCHAR(191) NOT NULL,
    `customerName` VARCHAR(191) NOT NULL,
    `customerEmail` VARCHAR(191) NOT NULL,
    `customerPhone` VARCHAR(191) NOT NULL DEFAULT '',
    `shippingAddressJson` TEXT NOT NULL,
    `currency` VARCHAR(191) NOT NULL,
    `rateSnapshotJson` TEXT NOT NULL,
    `subtotal` INTEGER NOT NULL,
    `discount` INTEGER NOT NULL DEFAULT 0,
    `couponCode` VARCHAR(191) NULL,
    `shipping` INTEGER NOT NULL DEFAULT 0,
    `tax` INTEGER NOT NULL DEFAULT 0,
    `taxRate` DOUBLE NOT NULL DEFAULT 0,
    `taxInclusive` BOOLEAN NOT NULL DEFAULT false,
    `total` INTEGER NOT NULL,
    `refundedTotal` INTEGER NOT NULL DEFAULT 0,
    `shippingMethodId` VARCHAR(191) NOT NULL,
    `shippingMethodLabel` VARCHAR(191) NOT NULL,
    `shippingMinDays` INTEGER NOT NULL,
    `shippingMaxDays` INTEGER NOT NULL,
    `paymentMethod` VARCHAR(191) NOT NULL,
    `paymentStatus` VARCHAR(191) NOT NULL DEFAULT 'unpaid',
    `paymentReference` VARCHAR(191) NOT NULL DEFAULT '',
    `fulfilmentStatus` VARCHAR(191) NOT NULL DEFAULT 'unfulfilled',
    `carrier` VARCHAR(191) NULL,
    `trackingNumber` VARCHAR(191) NULL,
    `trackingUrl` VARCHAR(191) NULL,
    `restocked` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `orders_number_key`(`number`),
    UNIQUE INDEX `orders_idempotencyKey_key`(`idempotencyKey`),
    INDEX `orders_customerId_idx`(`customerId`),
    INDEX `orders_customerEmail_idx`(`customerEmail`),
    INDEX `orders_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `order_lines` (
    `id` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `variantId` VARCHAR(191) NOT NULL,
    `sku` VARCHAR(191) NOT NULL,
    `nameEn` VARCHAR(191) NOT NULL,
    `nameHi` VARCHAR(191) NOT NULL DEFAULT '',
    `variantLabel` VARCHAR(191) NOT NULL DEFAULT '',
    `imageUrl` TEXT NOT NULL,
    `unitPrice` INTEGER NOT NULL,
    `quantity` INTEGER NOT NULL,
    `lineTotal` INTEGER NOT NULL,

    INDEX `order_lines_orderId_idx`(`orderId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `order_events` (
    `id` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(191) NOT NULL,
    `type` VARCHAR(191) NOT NULL,
    `message` TEXT NOT NULL,
    `actor` VARCHAR(191) NOT NULL,
    `at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `order_events_orderId_at_idx`(`orderId`, `at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `order_notes` (
    `id` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(191) NOT NULL,
    `author` VARCHAR(191) NOT NULL,
    `body` TEXT NOT NULL,
    `at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `order_notes_orderId_idx`(`orderId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `store_settings` ADD CONSTRAINT `store_settings_logoId_fkey` FOREIGN KEY (`logoId`) REFERENCES `media`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `shipping_zones` ADD CONSTRAINT `shipping_zones_settingsId_fkey` FOREIGN KEY (`settingsId`) REFERENCES `shipping_settings`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `tax_rules` ADD CONSTRAINT `tax_rules_settingsId_fkey` FOREIGN KEY (`settingsId`) REFERENCES `tax_settings`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `currency_configs` ADD CONSTRAINT `currency_configs_settingsId_fkey` FOREIGN KEY (`settingsId`) REFERENCES `currency_settings`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `coupon_redemptions` ADD CONSTRAINT `coupon_redemptions_couponId_fkey` FOREIGN KEY (`couponId`) REFERENCES `coupons`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `coupon_redemptions` ADD CONSTRAINT `coupon_redemptions_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `orders`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `customer_addresses` ADD CONSTRAINT `customer_addresses_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `wishlist_items` ADD CONSTRAINT `wishlist_items_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `wishlist_items` ADD CONSTRAINT `wishlist_items_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `password_reset_tokens` ADD CONSTRAINT `password_reset_tokens_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `orders` ADD CONSTRAINT `orders_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `order_lines` ADD CONSTRAINT `order_lines_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `orders`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `order_events` ADD CONSTRAINT `order_events_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `orders`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `order_notes` ADD CONSTRAINT `order_notes_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `orders`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

