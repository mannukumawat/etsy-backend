-- Owner password-reset tokens (C5). Only the sha256 hash of the token is stored;
-- the raw token exists only inside the emailed link. One row per request; a token is
-- single-use (used_at) and expires after 1 hour (expires_at).
CREATE TABLE `owner_password_reset_tokens` (
    `id` VARCHAR(191) NOT NULL,
    `owner_id` VARCHAR(191) NOT NULL,
    `token_hash` VARCHAR(64) NOT NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `used_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `owner_password_reset_tokens_token_hash_key`(`token_hash`),
    INDEX `owner_password_reset_tokens_owner_id_idx`(`owner_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci ENGINE=InnoDB;
