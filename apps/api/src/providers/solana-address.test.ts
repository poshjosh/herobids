import { describe, expect, it } from 'vitest';
import { deriveSolanaAddress } from './solana-address.js';

const BASE58_CHARS = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Reference encoder (same BigInt algorithm) so the vectors are independent of the code under test. */
function base58EncodeKeypair(bytes: Uint8Array): string {
  let num = 0n;
  for (const byte of bytes) num = num * 256n + BigInt(byte);
  let result = '';
  while (num > 0n) {
    result = BASE58_CHARS[Number(num % 58n)]! + result;
    num = num / 58n;
  }
  for (const byte of bytes) {
    if (byte === 0) result = '1' + result;
    else break;
  }
  return result || '1';
}

describe('deriveSolanaAddress', () => {
  it('derives the base58 pubkey from a 64-byte keypair (bytes 32-63)', () => {
    const keypair = base58EncodeKeypair(Uint8Array.from(Array<number>(32).fill(0).concat(Array<number>(32).fill(1))));
    const expected = base58EncodeKeypair(new Uint8Array(32).fill(1));
    expect(deriveSolanaAddress(keypair)).toBe(expected);
    expect(deriveSolanaAddress(keypair)).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });

  it('returns null for invalid base58 input', () => {
    expect(deriveSolanaAddress('0OIl-not-base58')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(deriveSolanaAddress('')).toBeNull();
  });

  it('returns null for 32-byte seed (unsupported — requires Ed25519 derivation)', () => {
    const seed = base58EncodeKeypair(new Uint8Array(32).fill(7));
    expect(deriveSolanaAddress(seed)).toBeNull();
  });

  it('round-trips an all-zero public key (leading zeros → "1" padding)', () => {
    const keypair = base58EncodeKeypair(Uint8Array.from(Array<number>(64).fill(0)));
    expect(deriveSolanaAddress(keypair)).toBe('1'.repeat(32));
  });
});

