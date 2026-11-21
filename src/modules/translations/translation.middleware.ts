import type { NextFunction, Request, Response } from 'express';
import { CONTENT_LANGS, type ContentLang } from './translation.schema.js';
import { collectLocalized, translateBody, type Localized } from './translation.service.js';
import { errorMessage, logger } from '../../shared/observability/logger.js';

const isContentLang = (v: unknown): v is ContentLang => typeof v === 'string' && (CONTENT_LANGS as readonly string[]).includes(v);

/**
 * Public storefront paths whose responses can carry a `hi` value (M18). Admin
 * responses are owner-facing English-only content and are never translated, and
 * /health and bulk endpoints never carry localised content — wrapping them only
 * paid the double JSON walk on every response for nothing.
 */
const PUBLIC_CONTENT_PATHS = [
  '/api/products',
  '/api/categories',
  '/api/content',
  '/api/collections',
  '/api/nav-links',
  '/api/item-groups',
  '/api/i18n',
  '/api/help',
  '/api/reviews',
  '/api/settings',
];

const isPublicContentPath = (path: string): boolean =>
  PUBLIC_CONTENT_PATHS.some((p) => path === p || path.startsWith(`${p}/`));

/** Hindi has been removed from the store. Content saved before that (homepage/page JSON, legacy
 *  columns) may still carry a `hi` value, so it is stripped from public storefront JSON responses. */
function stripHindi(value: unknown): void {
  const nodes: Localized[] = [];
  collectLocalized(value, nodes);
  for (const n of nodes) delete n.hi;
}

export function stripHindiResponses(req: Request, res: Response, next: NextFunction) {
  if (!isPublicContentPath(req.path)) return next();
  const send = res.json.bind(res);
  res.json = ((body: unknown) => {
    stripHindi(body);
    return send(body);
  }) as Response['json'];
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
