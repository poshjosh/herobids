import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { decryptCredential } from './crypto.js';

/**
 * Unit tests for decryptCredential.
 *
 * Regression coverage:
 *   Bug 2026-05-30-004 — stale credential blobs that lack a walletAddress field
 *   must decrypt without throwing, so the worker can apply its env-var fallback.
 */

const TEST_KEY = 'a'.repeat(64); // 64 hex chars = 32 bytes (valid AES-256 key)

/** Mirrors the AES-256-GCM encryption used by the API's encryptCredential(). */
function encryptForTest(data: string): string {
  const key = Buffer.from(TEST_KEY, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, tag]).toString('base64');
}

describe('decryptCredential', () => {
  it('decrypts a complete credential blob including walletAddress', () => {
    const blob = {
      apiKey: '0xapikey',
      secret: '0xsecret',
      walletAddress: '0xwallet',
    };
    const encrypted = encryptForTest(JSON.stringify(blob));

    const result = JSON.parse(decryptCredential(encrypted, TEST_KEY)) as {
      apiKey: string;
      secret: string;
      walletAddress?: string;
    };

    expect(result.apiKey).toBe('0xapikey');
    expect(result.secret).toBe('0xsecret');
    expect(result.walletAddress).toBe('0xwallet');
  });

  it('decrypts a stale blob without walletAddress without throwing (Bug 004 regression)', () => {
    // Old credential blobs only contained apiKey + secret.  walletAddress was
    // added later (Bug 001 fix).  Decrypting a stale blob must not throw — the
    // worker must be able to apply its env-var fallback instead of crashing.
    const staleBlob = { apiKey: '0xapikey', secret: '0xsecret' };
    const encrypted = encryptForTest(JSON.stringify(staleBlob));

    const result = JSON.parse(decryptCredential(encrypted, TEST_KEY)) as {
      apiKey: string;
      secret: string;
      walletAddress?: string;
    };

    expect(result.apiKey).toBe('0xapikey');
    expect(result.secret).toBe('0xsecret');
    expect(result.walletAddress).toBeUndefined();
  });

  it('env-var fallback activates when walletAddress is absent from stale blob (Bug 004 regression)', () => {
    // Worker pattern: let walletAddress = envValue; ... walletAddress = decrypted.walletAddress || walletAddress;
    // When the blob is stale, the pre-resolved env-var value must be kept.
    const staleBlob = { apiKey: '0xapikey', secret: '0xsecret' };
    const encrypted = encryptForTest(JSON.stringify(staleBlob));

    const decrypted = JSON.parse(decryptCredential(encrypted, TEST_KEY)) as {
      apiKey: string;
      secret: string;
      walletAddress?: string;
    };

    const envValue = '0xmainwallet_from_env';
    let resolved = envValue; // pre-populated from HYPERLIQUID_WALLET_ADDRESS env var
    resolved = decrypted.walletAddress || resolved;

    expect(resolved).toBe(envValue);
  });

  it('blob walletAddress takes precedence over the env-var fallback when present', () => {
    const blob = {
      apiKey: '0xapikey',
      secret: '0xsecret',
      walletAddress: '0xblob_wallet',
    };
    const encrypted = encryptForTest(JSON.stringify(blob));

    const decrypted = JSON.parse(decryptCredential(encrypted, TEST_KEY)) as {
      apiKey: string;
      secret: string;
      walletAddress?: string;
    };

    let resolved = '0xenv_wallet'; // env var
    resolved = decrypted.walletAddress || resolved;

    expect(resolved).toBe('0xblob_wallet');
  });

  it('throws when the encryption key is the wrong length', () => {
    expect(() => decryptCredential('data', 'tooshort')).toThrow(
      'CREDENTIAL_ENCRYPTION_KEY must be 64 hex chars',
    );
  });

  it('throws when the ciphertext has been tampered with (auth tag mismatch)', () => {
    const encrypted = encryptForTest(JSON.stringify({ apiKey: 'k', secret: 's' }));
    // Flip a byte in the middle of the ciphertext to break the auth tag
    const buf = Buffer.from(encrypted, 'base64');
    buf[20] ^= 0xff;
    const tampered = buf.toString('base64');

    expect(() => decryptCredential(tampered, TEST_KEY)).toThrow();
  });
});
