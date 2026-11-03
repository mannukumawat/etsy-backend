-- CreateTable
CREATE TABLE `content_translations` (
    `id` VARCHAR(191) NOT NULL,
    `lang` VARCHAR(8) NOT NULL,
    `sourceHash` CHAR(64) NOT NULL,
    `source` TEXT NOT NULL,
    `text` TEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `content_translations_lang_sourceHash_key`(`lang`, `sourceHash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
