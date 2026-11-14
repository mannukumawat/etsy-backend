import { Router } from 'express';
import { route } from '../../shared/http/async-route.js';
import { contactBodySchema } from './contact.schema.js';
import { submitContactMessage } from './contact.service.js';

export const contactRouter = Router();

contactRouter.post(
  '/contact',
  route(async (req, res) => {
    const body = contactBodySchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: { code: 'validation', issues: body.error.issues } });

    const { reference } = await submitContactMessage(body.data);
    res.json({ reference });
  }),
);
