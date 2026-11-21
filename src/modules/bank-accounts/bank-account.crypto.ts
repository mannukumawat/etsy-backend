import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from '../../shared/config/env.js';

// Bank-account encryption key, resolved from the validated env schema (see
// src/shared/config/env.ts) — never from a hardcoded fallback. Precedence:
// BANK_ACCOUNT_KEY (64 hex chars) → derive from APP_SECRET → derive from JWT_SECRET.
// JWT_SECRET is required by the schema, so there is always a real secret; when neither
// BANK_ACCOUNT_KEY nor APP_SECRET is set, env.ts logs a loud startup warning that bank
// data is encrypted under the JWT secret.
if (env.BANK_ACCOUNT_KEY && !(env.BANK_ACCOUNT_KEY.length === 64 && /^[0-9a-fA-F]+$/.test(env.BANK_ACCOUNT_KEY))) {
  console.warn('[bank-accounts] WARNING: BANK_ACCOUNT_KEY is set but is not 64 hex characters — it is ignored and the key is derived from APP_SECRET/JWT_SECRET instead. Set a 64-hex-char key in backend/.env.');
}

function getDerivedKey(): Buffer {
  const hexKey = env.BANK_ACCOUNT_KEY ?? '';
  if (hexKey.length === 64 && /^[0-9a-fA-F]+$/.test(hexKey)) {
    return Buffer.from(hexKey, 'hex');
  }
  const appSecret = env.APP_SECRET ?? env.JWT_SECRET;
  return createHash('sha256').update(appSecret).digest();
}

/** AES-256-GCM; stored as base64(iv[12] | authTag[16] | ciphertext). */
export function encryptAccountNumber(plain: string): string {
  const key = getDerivedKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}
