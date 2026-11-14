import { Router } from 'express';
import { route } from '../../shared/http/async-route.js';
import { getPublicSettings, syncRatesFromCron } from './settings.service.js';

export const publicSettingsRouter = Router();

// --- public (storefront) -------------------------------------------------------------------------
// A safe subset for display (see toPublicSettings in settings.mapper.ts).

publicSettingsRouter.get(
  '/',
  route(async (_req, res) => {
    res.json(await getPublicSettings());
  }),
);

// Called by a scheduler on hosts that cannot keep a timer alive (Vercel Cron sends `Authorization: Bearer $CRON_SECRET`).
// Disabled (404) unless CRON_SECRET is configured.
publicSettingsRouter.get(
  '/cron/currency-rates',
  route(async (req, res) => {
    res.json(await syncRatesFromCron(req.header('authorization')));
  }),
);
