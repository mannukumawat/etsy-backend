-- Persist the return-policy fields already exposed by the admin product editor and API.
ALTER TABLE `products`
    ADD COLUMN `returnsAllowed` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `exchangeAllowed` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `returnDays` INTEGER NOT NULL DEFAULT 30;
