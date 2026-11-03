-- Guest order access control: a one-time-issued random token (hashed) replaces plain order-id
-- lookup for guest checkouts. Account orders continue to be authorized via the customer session.
ALTER TABLE `orders`
  ADD COLUMN `guestTokenHash` VARCHAR(191) NULL,
  ADD COLUMN `guestTokenExpiresAt` DATETIME(3) NULL;

CREATE UNIQUE INDEX `orders_guestTokenHash_key` ON `orders`(`guestTokenHash`);
