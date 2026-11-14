import { randomBytes } from 'node:crypto';

/** Random lowercase-hex identifier built from `bytes` random bytes (two hex characters per byte). */
export const randomHexId = (bytes: number): string => randomBytes(bytes).toString('hex');
