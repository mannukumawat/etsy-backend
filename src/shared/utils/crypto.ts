import { createHash } from 'node:crypto';

/** SHA-256 of `text` as lowercase hex. */
export const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex');
