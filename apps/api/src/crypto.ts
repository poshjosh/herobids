import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;  // 96 bits for GCM
const TAG_LENGTH = 16; // 128 bits

export interface EncryptionMeta {
  algorithm: string;
  keyVersion: number;
}

export interface EncryptedPayload {
  /** Base64-encoded ciphertext (iv + encrypted + tag) */
  encryptedData: string;
  encryptionMeta: EncryptionMeta;
}

/**
 * Encrypt a plaintext credential blob using AES-256-GCM.
 * Key is loaded from environment at call time.
 */
export function encryptCredential(plaintext: string, keyHex: string, keyVersion = 1): EncryptedPayload {
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

/**
 * Get the encryption key from environment.
 * Throws if not configured.
 */
export function getEncryptionKey(): string {
  const key = process.env['CREDENTIAL_ENCRYPTION_KEY'];
  if (!key || key.length !== 64) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY env var must be set (64 hex chars = 32 bytes)');
  }
  return key;
}
