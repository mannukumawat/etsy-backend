-- Wallet multi-currency migration
-- Renames paise columns to generic "minor" (USD cents) and adds currency to WalletTopup.

-- WalletBalance: balancePaise → balanceMinor
ALTER TABLE `wallet_balances` RENAME COLUMN `balancePaise` TO `balanceMinor`;

-- WalletTransaction: amountPaise → amountMinor
ALTER TABLE `wallet_transactions` RENAME COLUMN `amountPaise` TO `amountMinor`;

-- WalletTopup: amountPaise → amountMinor + new currency column
ALTER TABLE `wallet_topups` RENAME COLUMN `amountPaise` TO `amountMinor`;
ALTER TABLE `wallet_topups` ADD COLUMN `currency` VARCHAR(10) NOT NULL DEFAULT 'USD' AFTER `amountMinor`;
