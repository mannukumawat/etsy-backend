-- AlterTable
ALTER TABLE `currency_configs` ADD COLUMN `autoRate` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `currency_settings` ADD COLUMN `autoSyncAt` DATETIME(3) NULL,
    ADD COLUMN `autoSyncError` TEXT NOT NULL;
