import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/**
 * Decrypt an AES-256-GCM encrypted credential blob.
 * Used by the worker for just-in-time credential decryption.
 */
export function decryptCredential(encryptedData: string, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY must be 64 hex chars (32 bytes)');
  }

  const packed = Buffer.from(encryptedData, 'base64');
  const iv = packed.subarray(0, IV_LENGTH);
  const tag = packed.subarray(packed.length - TAG_LENGTH);
  const ciphertext = packed.subarray(IV_LENGTH, packed.length - TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}
