import { Router } from 'express';
import { route } from '../../shared/http/async-route.js';
import { getMediaBytes, getCloudinaryUrl } from './media.service.js';

export const mediaRouter = Router();

/** The actual bytes. Public when the image is referenced by something currently published (see
 *  `isMediaPublic` in media.service.ts); otherwise owner-only, so a signed-in owner can still preview
 *  draft work. Either way the id is immutable — content changes get a new id — so a genuinely public
 *  image can be cached hard; an owner-only preview must not be, so a shared cache/CDN in front of this
 *  API can never serve it back to the next, unauthenticated requester. */
mediaRouter.get(
  '/:id',
  route(async (req, res) => {
    const row = await getMediaBytes(req.params.id, Boolean(req.owner));

    const cdnUrl = getCloudinaryUrl(row);
    if (cdnUrl) {
      res.redirect(301, cdnUrl);
      return;
    }

    res.setHeader('Content-Type', row.mimeType);
    // An uploaded SVG opened directly (not via <img>) is a document on this API's origin, where a script
    // inside it could read the readable CSRF cookie and make credentialed calls. Scripts never run inside
    // <img>, so this changes nothing for normal rendering; it only neuters the direct-open case.
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox");
    res.setHeader('Cache-Control', req.owner ? 'private, no-store' : 'public, max-age=31536000, immutable');
    if (!row.data) { res.status(404).end(); return; }
    res.setHeader('Content-Length', String(row.data.length));
    res.send(Buffer.from(row.data));
  }),
);
