import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/**
 * Encrypt a plaintext credential blob using AES-256-GCM.
 * Mirrors the API's encryptCredential for re-encryption during token refresh.
 */
export function encryptCredential(plaintext: string, keyHex: string, keyVersion = 1): { encryptedData: string; encryptionMeta: { algorithm: string; keyVersion: number } } {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY must be 64 hex chars (32 bytes)');
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Pack as: iv (12) + ciphertext + tag (16)
  const packed = Buffer.concat([iv, encrypted, tag]);

  return {
    encryptedData: packed.toString('base64'),
    encryptionMeta: { algorithm: ALGORITHM, keyVersion },
  };
}

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
