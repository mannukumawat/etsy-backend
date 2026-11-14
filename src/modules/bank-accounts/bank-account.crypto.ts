import { createCipheriv, createHash, randomBytes } from 'node:crypto';

function getDerivedKey(): Buffer {
  // 32-byte key: prefer BANK_ACCOUNT_KEY (64 hex chars), else derive from app secret.
  const hexKey = process.env.BANK_ACCOUNT_KEY ?? '';
  if (hexKey.length === 64 && /^[0-9a-fA-F]+$/.test(hexKey)) {
    return Buffer.from(hexKey, 'hex');
  }
  const appSecret = process.env.APP_SECRET ?? process.env.JWT_SECRET ?? 'dev-secret-change-me';
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
