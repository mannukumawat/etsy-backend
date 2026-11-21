-- Admin audit log (H7) + paid-but-no-order payment recoveries (H5).
-- Both tables are append-only records written by raw SQL (same pattern as `refunds`):
-- no Prisma model, no update/delete path.
CREATE TABLE `admin_audit_log` (
    `id` VARCHAR(191) NOT NULL,
    `actor` VARCHAR(191) NOT NULL,
    `action` VARCHAR(191) NOT NULL,
    `target_type` VARCHAR(191) NOT NULL,
    `target_id` VARCHAR(191) NULL,
    `detail` TEXT NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `admin_audit_log_actor_idx`(`actor`),
    INDEX `admin_audit_log_action_idx`(`action`),
    INDEX `admin_audit_log_created_at_idx`(`created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci ENGINE=InnoDB;

-- A Razorpay payment the gateway says was captured, for which no store order exists
-- (checkout failed after capture). `status`: 'unmatched' | 'resolved' | 'refunded'.
-- `razorpay_payment_id` is unique: a redelivered webhook updates the same row.
CREATE TABLE `payment_recoveries` (
    `id` VARCHAR(191) NOT NULL,
    `razorpay_payment_id` VARCHAR(191) NOT NULL,
    `razorpay_order_id` VARCHAR(191) NOT NULL,
    `amount` INT NOT NULL,
    `currency` VARCHAR(10) NOT NULL,
    `customer_email` VARCHAR(191) NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'unmatched',
    `resolution_note` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `payment_recoveries_razorpay_payment_id_key`(`razorpay_payment_id`),
    INDEX `payment_recoveries_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci ENGINE=InnoDB;
