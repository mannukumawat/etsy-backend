import { Router } from 'express';
import { route } from '../../shared/http/async-route.js';
import { requireOwner } from '../../shared/middleware/auth.middleware.js';
import { currencySettingsSchema, shippingSettingsSchema, storeSettingsSchema, taxSettingsSchema } from './settings.schema.js';
import { loadAdminSettings, refreshLiveCurrencyRates, saveCurrencySettings, saveShippingSettings, saveStoreSettings, saveTaxSettings } from './settings.service.js';

export const settingsRouter = Router();

settingsRouter.use(requireOwner);

settingsRouter.get('/', route(async (_req, res) => res.json(await loadAdminSettings())));

settingsRouter.put(
  '/store',
  route(async (req, res) => {
    const input = storeSettingsSchema.parse(req.body);
    res.json(await saveStoreSettings(input, req.owner!.email));
  }),
);

settingsRouter.put(
  '/shipping',
  route(async (req, res) => {
    const input = shippingSettingsSchema.parse(req.body);
    res.json(await saveShippingSettings(input, req.owner!.email));
  }),
);

settingsRouter.put(
  '/tax',
  route(async (req, res) => {
    const input = taxSettingsSchema.parse(req.body);
    res.json(await saveTaxSettings(input, req.owner!.email));
  }),
);

settingsRouter.put(
  '/currencies',
  route(async (req, res) => {
    const input = currencySettingsSchema.parse(req.body);
    res.json(await saveCurrencySettings(input, req.owner!.email));
  }),
);

// Fetch live exchange rates right now for every currency marked "Live" (the same job the scheduler runs).
settingsRouter.post(
  '/currencies/refresh',
  route(async (_req, res) => {
    res.json(await refreshLiveCurrencyRates());
  }),
);
