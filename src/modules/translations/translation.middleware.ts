import type { NextFunction, Request, Response } from 'express';
import { CONTENT_LANGS, type ContentLang } from './translation.schema.js';
import { translateBody } from './translation.service.js';
import { errorMessage, logger } from '../../shared/observability/logger.js';

const isContentLang = (v: unknown): v is ContentLang => typeof v === 'string' && (CONTENT_LANGS as readonly string[]).includes(v);

export function stripHindiResponses(_req: Request, _res: Response, next: NextFunction) {
  next();
}

/** Applies to translated public GETs only; admin requests never send the header, so they're untouched. */
export function translateResponses(req: Request, res: Response, next: NextFunction) {
  const lang = req.get('x-lang');
  if (req.method !== 'GET' || !isContentLang(lang) || req.path.startsWith('/api/admin') || req.path === '/health') return next();
  const send = res.json.bind(res);
  res.json = ((body: unknown) => {
    translateBody(body, lang)
      .catch((e) => logger.error('translation overlay failed', { requestId: req.requestId ?? null, error: errorMessage(e) }))
      .finally(() => send(body));
    return res;
  }) as Response['json'];
  res.vary('x-lang');
  next();
}
