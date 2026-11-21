-- Backend fix (58 findings, 2026-11-21): persist Razorpay ids on orders, promote
-- returns/exchanges/refunds/bank-accounts to real Prisma models, create the missing
-- contact_messages table, add stock holds + revoked sessions, make coupon redemption
-- per-customer unique, and add a FULLTEXT index for product search.
--
-- NOTE: `prisma migrate deploy` cannot run in the sandboxed environment (Prisma engine
-- download fails with ECONNRESET), so this migration is UNAPPLIED. Apply it from a
-- machine with network access to the dev database:
--   npx prisma migrate deploy
-- It is written to be safe on a dev database where the one-shot scripts
-- (migrate-returns.ts / migrate-exchanges.ts) may already have created some of these
-- tables: CREATE TABLE IF NOT EXISTS + conditional ADD COLUMN are used throughout.

-- 1. Orders: persist the Razorpay order id; paymentReference becomes the nullable
-- Razorpay payment id with a UNIQUE constraint (one gateway payment funds at most
-- one order). Legacy "" values become NULL first (MySQL unique indexes ignore NULLs,
-- so several legacy rows may stay NULL).
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'razorpayOrderId');
SET @ddl = IF(@col_exists = 0, 'ALTER TABLE `orders` ADD COLUMN `razorpayOrderId` VARCHAR(255) NULL', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
ALTER TABLE `orders` MODIFY `paymentReference` VARCHAR(255) NULL;
UPDATE `orders` SET `paymentReference` = NULL WHERE `paymentReference` = '';
SET @idx_exists = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND INDEX_NAME = 'orders_paymentReference_key');
SET @ddl = IF(@idx_exists = 0, 'CREATE UNIQUE INDEX `orders_paymentReference_key` ON `orders` (`paymentReference`)', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @idx_exists = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND INDEX_NAME = 'orders_razorpayOrderId_idx');
SET @ddl = IF(@idx_exists = 0, 'CREATE INDEX `orders_razorpayOrderId_idx` ON `orders` (`razorpayOrderId`)', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @idx_exists = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND INDEX_NAME = 'orders_fulfilmentStatus_idx');
SET @ddl = IF(@idx_exists = 0, 'CREATE INDEX `orders_fulfilmentStatus_idx` ON `orders` (`fulfilmentStatus`)', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2. Returns / exchanges / refunds tables (same definitions as the deleted one-shot
-- scripts, so existing dev data keeps working).
CREATE TABLE IF NOT EXISTS `return_requests` (
    `id` VARCHAR(191) NOT NULL,
    `reference` VARCHAR(191) NOT NULL,
    `order_id` VARCHAR(191) NOT NULL,
    `order_line_id` VARCHAR(191) NOT NULL,
    `variant_id` VARCHAR(191) NOT NULL,
    `requested_qty` INT NOT NULL,
    `approved_qty` INT NULL,
    `received_qty` INT NULL,
    `accepted_qty` INT NULL,
    `restock_qty` INT NULL,
    `reason` VARCHAR(191) NOT NULL,
    `customer_note` TEXT NULL,
    `admin_note` TEXT NULL,
    `rejection_reason` TEXT NULL,
    `photos` TEXT NULL,
    `status` VARCHAR(50) NOT NULL DEFAULT 'requested',
    `shipping_method` VARCHAR(50) NULL,
    `customer_carrier` VARCHAR(191) NULL,
    `customer_tracking` VARCHAR(191) NULL,
    `pickup_address` TEXT NULL,
    `return_carrier` VARCHAR(191) NULL,
    `return_tracking` VARCHAR(191) NULL,
    `refundable_amount` INT NOT NULL DEFAULT 0,
    `shipping_fee` INT NOT NULL DEFAULT 0,
    `refund_amount` INT NULL,
    `return_window_days` INT NOT NULL DEFAULT 7,
    `refund_account_id` VARCHAR(191) NULL,
    `refund_method_override` VARCHAR(50) NULL,
    `requested_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `decided_at` DATETIME(3) NULL,
    `received_at` DATETIME(3) NULL,
    `inspected_at` DATETIME(3) NULL,
    `refunded_at` DATETIME(3) NULL,
    UNIQUE KEY `uq_return_reference` (`reference`),
    INDEX `idx_return_order` (`order_id`),
    INDEX `idx_return_status` (`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `return_events` (
    `id` VARCHAR(191) NOT NULL,
    `return_id` VARCHAR(191) NOT NULL,
    `type` VARCHAR(100) NOT NULL,
    `actor` VARCHAR(50) NOT NULL,
    `actor_id` VARCHAR(191) NULL,
    `message` TEXT NULL,
    `data` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX `idx_rev_return` (`return_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `refunds` (
    `id` VARCHAR(191) NOT NULL,
    `order_id` VARCHAR(191) NOT NULL,
    `return_id` VARCHAR(191) NULL,
    `amount` INT NOT NULL,
    `reason` TEXT NOT NULL,
    `method` VARCHAR(50) NOT NULL DEFAULT 'original',
    `status` VARCHAR(50) NOT NULL DEFAULT 'pending',
    `reference` VARCHAR(191) NULL,
    `completed_at` DATETIME(3) NULL,
    `failed_at` DATETIME(3) NULL,
    `recorded_by` VARCHAR(191) NULL,
    `note` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    INDEX `idx_refund_order` (`order_id`),
    UNIQUE KEY `uq_refund_return` (`return_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `exchange_requests` (
    `id` VARCHAR(191) NOT NULL,
    `reference` VARCHAR(191) NOT NULL,
    `order_id` VARCHAR(191) NOT NULL,
    `order_line_id` VARCHAR(191) NOT NULL,
    `original_variant_id` VARCHAR(191) NOT NULL,
    `replacement_variant_id` VARCHAR(191) NOT NULL,
    `requested_qty` INT NOT NULL,
    `approved_qty` INT NULL,
    `reason` VARCHAR(191) NOT NULL,
    `customer_note` TEXT NULL,
    `admin_note` TEXT NULL,
    `rejection_reason` TEXT NULL,
    `status` VARCHAR(50) NOT NULL DEFAULT 'requested',
    `price_difference` INT NOT NULL DEFAULT 0,
    `exchange_window_days` INT NOT NULL DEFAULT 7,
    `replacement_carrier` VARCHAR(191) NULL,
    `replacement_tracking` VARCHAR(191) NULL,
    `requested_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `decided_at` DATETIME(3) NULL,
    `shipped_at` DATETIME(3) NULL,
    `delivered_at` DATETIME(3) NULL,
    `closed_at` DATETIME(3) NULL,
    UNIQUE KEY `uq_exchange_reference` (`reference`),
    INDEX `idx_exchange_order` (`order_id`),
    INDEX `idx_exchange_line` (`order_line_id`),
    INDEX `idx_exchange_status` (`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `exchange_events` (
    `id` VARCHAR(191) NOT NULL,
    `exchange_id` VARCHAR(191) NOT NULL,
    `type` VARCHAR(100) NOT NULL,
    `actor` VARCHAR(50) NOT NULL,
    `actor_id` VARCHAR(191) NULL,
    `message` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX `idx_eev_exchange` (`exchange_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `customer_bank_accounts` (
    `id` VARCHAR(191) NOT NULL,
    `customer_id` VARCHAR(191) NOT NULL,
    `account_holder_name` VARCHAR(255) NOT NULL,
    `account_number_encrypted` TEXT NOT NULL,
    `account_number_last4` CHAR(4) NOT NULL,
    `ifsc_code` VARCHAR(11) NOT NULL,
    `is_active` TINYINT(1) NOT NULL DEFAULT 1,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX `idx_bac_customer` (`customer_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci ENGINE=InnoDB;

-- 3. contact_messages (C8): the model existed but no migration ever created the table,
-- so a fresh `prisma migrate deploy` left the admin contacts list without a table.
CREATE TABLE IF NOT EXISTS `contact_messages` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `email` VARCHAR(200) NOT NULL,
    `subject` VARCHAR(50) NOT NULL,
    `orderNumber` VARCHAR(30) NOT NULL DEFAULT '',
    `message` TEXT NOT NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'unread',
    `note` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    INDEX `contact_messages_status_createdAt_idx`(`status`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci ENGINE=InnoDB;

-- 4. Stock holds (H5): short-lived reservations created when a Razorpay order is
-- created at checkout, consumed when placeOrder succeeds.
CREATE TABLE IF NOT EXISTS `stock_holds` (
    `id` VARCHAR(191) NOT NULL,
    `variantId` VARCHAR(191) NOT NULL,
    `quantity` INT NOT NULL,
    `razorpayOrderId` VARCHAR(255) NOT NULL,
    `customerKey` VARCHAR(191) NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE INDEX `stock_holds_razorpayOrderId_variantId_key`(`razorpayOrderId`, `variantId`),
    INDEX `stock_holds_variantId_expiresAt_idx`(`variantId`, `expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci ENGINE=InnoDB;

-- 5. Revoked sessions (M15): sha256 of the JWT id, checked by both auth middlewares.
CREATE TABLE IF NOT EXISTS `revoked_sessions` (
    `id` VARCHAR(191) NOT NULL,
    `jtiHash` VARCHAR(64) NOT NULL,
    `realm` VARCHAR(20) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE INDEX `revoked_sessions_jtiHash_key`(`jtiHash`),
    INDEX `revoked_sessions_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci ENGINE=InnoDB;

-- 6. order_lines extra columns (conditional: MySQL has no ADD COLUMN IF NOT EXISTS).
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_lines' AND COLUMN_NAME = 'cancelled_qty');
SET @ddl = IF(@col_exists = 0, 'ALTER TABLE `order_lines` ADD COLUMN `cancelled_qty` INT NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_lines' AND COLUMN_NAME = 'returned_qty');
SET @ddl = IF(@col_exists = 0, 'ALTER TABLE `order_lines` ADD COLUMN `returned_qty` INT NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_lines' AND COLUMN_NAME = 'exchanged_qty');
SET @ddl = IF(@col_exists = 0, 'ALTER TABLE `order_lines` ADD COLUMN `exchanged_qty` INT NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_lines' AND COLUMN_NAME = 'delivered_at');
SET @ddl = IF(@col_exists = 0, 'ALTER TABLE `order_lines` ADD COLUMN `delivered_at` DATETIME(3) NULL', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_lines' AND COLUMN_NAME = 'return_window_days');
SET @ddl = IF(@col_exists = 0, 'ALTER TABLE `order_lines` ADD COLUMN `return_window_days` INT NULL', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_lines' AND COLUMN_NAME = 'return_shipping_fee');
SET @ddl = IF(@col_exists = 0, 'ALTER TABLE `order_lines` ADD COLUMN `return_shipping_fee` INT NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 7. return_requests refund-account columns (added by migrate-exchanges.ts step 2;
-- included in the CREATE TABLE above, added here only if the table already existed).
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'return_requests' AND COLUMN_NAME = 'refund_account_id');
SET @ddl = IF(@col_exists = 0, 'ALTER TABLE `return_requests` ADD COLUMN `refund_account_id` VARCHAR(191) NULL', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'return_requests' AND COLUMN_NAME = 'refund_method_override');
SET @ddl = IF(@col_exists = 0, 'ALTER TABLE `return_requests` ADD COLUMN `refund_method_override` VARCHAR(50) NULL', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 8. Per-customer coupon limit: drop the plain index, add a UNIQUE constraint (H15).
-- Dev data may already contain duplicate redemptions (the race this fixes); keep the
-- earliest row per (coupon, customer) and drop the rest before adding the constraint.
DELETE c1 FROM `coupon_redemptions` c1
INNER JOIN `coupon_redemptions` c2
  ON c1.`couponId` = c2.`couponId` AND c1.`customerKey` = c2.`customerKey`
  AND (c1.`createdAt` > c2.`createdAt` OR (c1.`createdAt` = c2.`createdAt` AND c1.`id` > c2.`id`));
SET @idx_exists = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'coupon_redemptions' AND INDEX_NAME = 'coupon_redemptions_couponId_customerKey_key');
SET @ddl = IF(@idx_exists = 0, 'CREATE UNIQUE INDEX `coupon_redemptions_couponId_customerKey_key` ON `coupon_redemptions` (`couponId`, `customerKey`)', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 9. Product search: FULLTEXT index on the search haystack (M7). The service switches
-- from LIKE '%q%' to MATCH ... AGAINST in boolean mode.
SET @idx_exists = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND INDEX_NAME = 'products_searchText_idx');
SET @ddl = IF(@idx_exists = 0, 'CREATE FULLTEXT INDEX `products_searchText_idx` ON `products` (`searchText`)', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 10. Razorpay orders created at checkout (L4): binds the gateway order to the
-- server-computed amount/currency and the requester; the receipt is the idempotency
-- key, derived server-side. 'created' | 'paid' | 'expired'.
CREATE TABLE IF NOT EXISTS `razorpay_orders` (
    `id` VARCHAR(191) NOT NULL,
    `razorpayOrderId` VARCHAR(255) NOT NULL,
    `amount` INT NOT NULL,
    `currency` VARCHAR(10) NOT NULL,
    `receipt` VARCHAR(40) NOT NULL,
    `customerKey` VARCHAR(191) NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'created',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE INDEX `razorpay_orders_razorpayOrderId_key`(`razorpayOrderId`),
    INDEX `razorpay_orders_customerKey_idx`(`customerKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci ENGINE=InnoDB;
