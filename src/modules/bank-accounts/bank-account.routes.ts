import { Router } from 'express';
import { route } from '../../shared/http/async-route.js';
import { requireCustomer } from '../../shared/middleware/customer-auth.middleware.js';
import { toPublicBankAccount } from './bank-account.mapper.js';
import { addBankAccountSchema } from './bank-account.schema.js';
import { addBankAccount, listBankAccounts, removeBankAccount } from './bank-account.service.js';

export const customerBankAccountsRouter = Router();
customerBankAccountsRouter.use(requireCustomer);

// GET / — list saved bank accounts (masked)
customerBankAccountsRouter.get(
  '/',
  route(async (req, res) => {
    const rows = await listBankAccounts(req.customer!.sub);
    res.json({ items: rows.map(toPublicBankAccount) });
  }),
);

// POST / — add bank account
customerBankAccountsRouter.post(
  '/',
  route(async (req, res) => {
    const input = addBankAccountSchema.parse(req.body);
    const row = await addBankAccount(req.customer!.sub, input);
    res.status(201).json(toPublicBankAccount(row));
  }),
);

// DELETE /:id — soft-remove bank account
customerBankAccountsRouter.delete(
  '/:id',
  route(async (req, res) => {
    await removeBankAccount(req.customer!.sub, req.params.id);
    res.json({ ok: true });
  }),
);
