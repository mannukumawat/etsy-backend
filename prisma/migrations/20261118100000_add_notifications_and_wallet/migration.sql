-- Drop any partially-created tables from a failed prior run before recreating them.
DROP TABLE IF EXISTS `wallet_topups`;
DROP TABLE IF EXISTS `wallet_transactions`;
DROP TABLE IF EXISTS `wallet_balances`;
DROP TABLE IF EXISTS `notification_sends`;
DROP TABLE IF EXISTS `notification_records`;
DROP TABLE IF EXISTS `fcm_tokens`;

-- CreateTable: fcm_tokens
CREATE TABLE `fcm_tokens` (
    `id` VARCHAR(191) NOT NULL,
    `customerId` VARCHAR(191) NOT NULL,
    `token` VARCHAR(512) NOT NULL,
    `deviceInfo` VARCHAR(255) NOT NULL DEFAULT '',
    `lastSeen` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `fcm_tokens_token_key`(`token`),
    INDEX `fcm_tokens_customerId_idx`(`customerId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci ENGINE=InnoDB;

-- CreateTable: notification_records
CREATE TABLE `notification_records` (
    `id` VARCHAR(191) NOT NULL,
    `recipientId` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(20) NOT NULL,
    `event` VARCHAR(100) NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `body` TEXT NOT NULL,
    `link` VARCHAR(512) NOT NULL DEFAULT '',
    `readAt` DATETIME(3) NULL,
    `pushStatus` VARCHAR(20) NOT NULL DEFAULT 'pending',
    `pushSentAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `customerId` VARCHAR(191) NULL,

    INDEX `notification_records_recipientId_createdAt_idx`(`recipientId`, `createdAt`),
    INDEX `notification_records_event_idx`(`event`),
    INDEX `notification_records_customerId_idx`(`customerId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci ENGINE=InnoDB;

-- CreateTable: notification_sends
CREATE TABLE `notification_sends` (
    `id` VARCHAR(191) NOT NULL,
    `senderId` VARCHAR(191) NOT NULL,
    `recipientType` VARCHAR(10) NOT NULL,
    `recipientId` VARCHAR(191) NULL,
    `title` VARCHAR(255) NOT NULL,
    `body` TEXT NOT NULL,
    `sentAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `successCount` INT NOT NULL DEFAULT 0,
    `failCount` INT NOT NULL DEFAULT 0,

    INDEX `notification_sends_sentAt_idx`(`sentAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci ENGINE=InnoDB;

-- CreateTable: wallet_balances
CREATE TABLE `wallet_balances` (
    `customerId` VARCHAR(191) NOT NULL,
    `balancePaise` INT NOT NULL DEFAULT 0,
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`customerId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci ENGINE=InnoDB;

-- CreateTable: wallet_transactions
CREATE TABLE `wallet_transactions` (
    `id` VARCHAR(191) NOT NULL,
    `customerId` VARCHAR(191) NOT NULL,
    `type` VARCHAR(20) NOT NULL,
    `amountPaise` INT NOT NULL,
    `balanceAfter` INT NOT NULL,
    `reference` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(191) NULL,
    `topupId` VARCHAR(191) NULL,
    `note` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `wallet_transactions_reference_key`(`reference`),
    INDEX `wallet_transactions_customerId_createdAt_idx`(`customerId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci ENGINE=InnoDB;

-- CreateTable: wallet_topups
CREATE TABLE `wallet_topups` (
    `id` VARCHAR(191) NOT NULL,
    `customerId` VARCHAR(191) NOT NULL,
    `amountPaise` INT NOT NULL,
    `razorpayOrderId` VARCHAR(255) NOT NULL,
    `razorpayPaymentId` VARCHAR(255) NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'pending',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `wallet_topups_razorpayOrderId_key`(`razorpayOrderId`),
    INDEX `wallet_topups_customerId_idx`(`customerId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci ENGINE=InnoDB;

-- AddForeignKey: fcm_tokens -> customers
ALTER TABLE `fcm_tokens` ADD CONSTRAINT `fcm_tokens_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: notification_records -> customers (nullable)
ALTER TABLE `notification_records` ADD CONSTRAINT `notification_records_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: wallet_balances -> customers
ALTER TABLE `wallet_balances` ADD CONSTRAINT `wallet_balances_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: wallet_transactions -> customers
ALTER TABLE `wallet_transactions` ADD CONSTRAINT `wallet_transactions_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: wallet_topups -> customers
ALTER TABLE `wallet_topups` ADD CONSTRAINT `wallet_topups_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
