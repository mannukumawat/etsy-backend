import type { NextFunction, Request, Response } from 'express';
import { CONTENT_LANGS, type ContentLang } from './translation.schema.js';
import { collectLocalized, translateBody, type Localized } from './translation.service.js';

const isContentLang = (v: unknown): v is ContentLang => typeof v === 'string' && (CONTENT_LANGS as readonly string[]).includes(v);

/** Hindi has been removed from the store. Content saved before that (homepage/page JSON, legacy
 *  columns) may still carry a `hi` value, so it is stripped from every JSON response, admin included. */
function stripHindi(value: unknown): void {
  const nodes: Localized[] = [];
  collectLocalized(value, nodes);
  for (const n of nodes) delete n.hi;
}

export function stripHindiResponses(_req: Request, res: Response, next: NextFunction) {
  const send = res.json.bind(res);
  res.json = ((body: unknown) => {
    stripHindi(body);
    return send(body);
  }) as Response['json'];
  next();
}

/** Applies to GET responses only; admin requests never send the header, so they're untouched. */
export function translateResponses(req: Request, res: Response, next: NextFunction) {
  const lang = req.get('x-lang');
  if (req.method !== 'GET' || !isContentLang(lang) || req.path.startsWith('/api/admin')) return next();
  const send = res.json.bind(res);
  res.json = ((body: unknown) => {
    translateBody(body, lang)
      .catch((e) => console.error('translation overlay failed:', e))
      .finally(() => send(body));
    return res;
  }) as Response['json'];
  res.vary('x-lang');
  next();
}
