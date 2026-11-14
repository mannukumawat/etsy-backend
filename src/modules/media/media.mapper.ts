import { mediaUrl } from '../../shared/config/env.js';

/** Owner-facing metadata for one media row (never the bytes). */
export function toAdminMedia(m: {
  id: string; fileName: string; mimeType: string; sizeBytes: number; width: number | null; height: number | null;
  altEn: string; altHi: string; source: string; createdAt: Date; cloudinaryUrl?: string | null; cloudinaryId?: string | null;
}) {
  return {
    id: m.id,
    url: m.cloudinaryUrl ?? mediaUrl(m.id),
    fileName: m.fileName,
    mimeType: m.mimeType,
    sizeBytes: m.sizeBytes,
    width: m.width,
    height: m.height,
    alt: { en: m.altEn, hi: m.altHi },
    source: m.source,
    createdAt: m.createdAt.toISOString(),
  };
}
