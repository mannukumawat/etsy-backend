-- AlterTable
ALTER TABLE `customers`
  ADD COLUMN `avatarUrl`     LONGTEXT NULL,
  ADD COLUMN `gender`        VARCHAR(100) NULL,
  ADD COLUMN `languages`     VARCHAR(200) NULL,
  ADD COLUMN `occupation`    VARCHAR(200) NULL,
  ADD COLUMN `pincode`       VARCHAR(20) NULL,
  ADD COLUMN `city`          VARCHAR(100) NULL,
  ADD COLUMN `state`         VARCHAR(100) NULL,
  ADD COLUMN `dateOfBirth`   VARCHAR(20) NULL,
  ADD COLUMN `maritalStatus` VARCHAR(100) NULL,
  ADD COLUMN `numberOfKids`  VARCHAR(10) NULL,
  ADD COLUMN `education`     VARCHAR(100) NULL,
  ADD COLUMN `monthlyIncome` VARCHAR(100) NULL;
