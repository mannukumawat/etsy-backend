/*
  Warnings:

  - You are about to drop the column `variantLabel` on the `order_lines` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE `order_lines` DROP COLUMN `variantLabel`,
    ADD COLUMN `slug` VARCHAR(191) NOT NULL DEFAULT '',
    ADD COLUMN `variantLabelEn` VARCHAR(191) NOT NULL DEFAULT '',
    ADD COLUMN `variantLabelHi` VARCHAR(191) NOT NULL DEFAULT '';
