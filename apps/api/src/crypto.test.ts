/**
 * Tests for the credential encryption/decryption helpers in crypto.ts.
 *
 * Regression test for bug 2026-06-04-007 — CREDENTIAL_ENCRYPTION_KEY was
 * missing from docker-compose.yaml, causing any operation that read or wrote a
 * credential (create, decrypt for bot start) to throw at runtime instead of
 * failing at startup with a clear diagnostic message.
 *
 * The fix added a dev-safe default key to docker-compose.yaml.  These tests
 * verify that the crypto helpers:
 *   1. Reject a missing or incorrectly-sized key with a clear error (so a
 *      mis-configured deployment fails loudly rather than silently).
 *   2. Round-trip encrypt→decrypt correctly with a valid 64-hex-char key.
 *   3. `getEncryptionKey()` throws when CREDENTIAL_ENCRYPTION_KEY is not set.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  encryptCredential,
  decryptCredential,
  getEncryptionKey,
} from './crypto.js';

const VALID_KEY = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

describe('encryptCredential / decryptCredential', () => {
  it('round-trips a plaintext string', () => {
    const { encryptedData } = encryptCredential('{"apiKey":"sk-test","secret":"abcdef"}', VALID_KEY);
    const decrypted = decryptCredential(encryptedData, VALID_KEY);
    expect(decrypted).toBe('{"apiKey":"sk-test","secret":"abcdef"}');
  });

  it('produces a different ciphertext on each call (random IV)', () => {
    const plaintext = 'same-data';
    const { encryptedData: a } = encryptCredential(plaintext, VALID_KEY);
    const { encryptedData: b } = encryptCredential(plaintext, VALID_KEY);
    expect(a).not.toBe(b);
  });

  it('rejects a key that is too short', () => {
    const shortKey = '1234567890abcdef';
    expect(() => encryptCredential('test', shortKey)).toThrow('64 hex chars');
  });

  it('rejects a key that is too long', () => {
    const longKey = VALID_KEY + 'aa';
    expect(() => encryptCredential('test', longKey)).toThrow('64 hex chars');
  });

  it('decryptCredential rejects a key that is the wrong size', () => {
    const { encryptedData } = encryptCredential('test', VALID_KEY);
    expect(() => decryptCredential(encryptedData, 'tooshort')).toThrow('64 hex chars');
  });

  it('decryptCredential rejects tampered ciphertext', () => {
    const { encryptedData } = encryptCredential('test', VALID_KEY);
    // Flip the last byte of the base64 payload — GCM auth tag will reject this.
    const tampered = encryptedData.slice(0, -4) + 'AAAA';
    expect(() => decryptCredential(tampered, VALID_KEY)).toThrow();
  });
});

// bug-007 regression: CREDENTIAL_ENCRYPTION_KEY must be set in the deployment
// environment.  Without it every credential read/write fails at runtime instead
// of at startup, which caused bot starts to silently crash.
// `getEncryptionKey()` is the single point of env-var access used by both the
// API (credential create/rotate) and worker (credential decrypt on bot start).
describe('getEncryptionKey', () => {
  const originalKey = process.env['CREDENTIAL_ENCRYPTION_KEY'];

  beforeEach(() => {
    delete process.env['CREDENTIAL_ENCRYPTION_KEY'];
  });

  afterEach(() => {
    if (originalKey !== undefined) {
      process.env['CREDENTIAL_ENCRYPTION_KEY'] = originalKey;
    } else {
      delete process.env['CREDENTIAL_ENCRYPTION_KEY'];
    }
  });

  // bug-007 regression: missing env var must throw immediately with a clear
  // message so a mis-configured deployment fails loudly at the first key access,
  // not silently when a bot attempts to start.
  it('throws when CREDENTIAL_ENCRYPTION_KEY is not set (bug-007 regression)', () => {
    expect(() => getEncryptionKey()).toThrow('CREDENTIAL_ENCRYPTION_KEY');
  });

  it('throws when CREDENTIAL_ENCRYPTION_KEY is set to a wrong-length value', () => {
    process.env['CREDENTIAL_ENCRYPTION_KEY'] = 'tooshort';
    expect(() => getEncryptionKey()).toThrow('CREDENTIAL_ENCRYPTION_KEY');
  });

  it('returns the key when CREDENTIAL_ENCRYPTION_KEY is a valid 64-hex-char string', () => {
    process.env['CREDENTIAL_ENCRYPTION_KEY'] = VALID_KEY;
    expect(getEncryptionKey()).toBe(VALID_KEY);
  });
});
