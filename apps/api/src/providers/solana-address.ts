// Solana address derivation (manual-Jupiter provider-link setup).
//
// Copied VERBATIM (byte-faithful) from the deleted local package
// `packages/venues/src/solana-signer.ts` lines 238–304 (Slice 4 Plan B, ruling:
// amended Option A — self-contained `deriveSolanaAddress` + private base58
// helpers relocate to an API-owned platform utility per the D1-3b ruling).
// Pure code, no imports from the deleted package.

// Minimal base58 encode/decode utilities to avoid an extra dependency

/**
 * Derive a Solana wallet address (base58 public key) from a base58-encoded
 * private key. Supports 64-byte keypair format (private + public key).
 * 32-byte seeds are not supported (requires Ed25519 derivation).
 *
 * Returns null when the key cannot be decoded or is an unrecognised length.
 */
export function deriveSolanaAddress(base58PrivateKey: string): string | null {
  try {
    const secretKey = base58Decode(base58PrivateKey);
    if (secretKey.length === 64) {
      // Standard Solana keypair: bytes 32-63 are the Ed25519 public key
      return base58Encode(secretKey.slice(32));
    }
    return null;
  } catch {
    return null;
  }
}

const BASE58_CHARS = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(bytes: Uint8Array): string {
  let num = BigInt(0);
  for (const byte of bytes) {
    num = num * 256n + BigInt(byte);
  }

  let result = '';
  while (num > 0n) {
    const remainder = Number(num % 58n);
    num = num / 58n;
    result = BASE58_CHARS[remainder]! + result;
  }

  // Leading zeros become '1'
  for (const byte of bytes) {
    if (byte === 0) result = '1' + result;
    else break;
  }

  return result || '1';
}

function base58Decode(str: string): Uint8Array {
  let num = BigInt(0);
  for (const char of str) {
    const idx = BASE58_CHARS.indexOf(char);
    if (idx === -1) throw new Error(`Invalid base58 character: ${char}`);
    num = num * 58n + BigInt(idx);
  }

  // Convert bigint to bytes directly (avoiding hex conversion which can drop leading zeros).
  const bytes: number[] = [];
  while (num > 0n) {
    bytes.unshift(Number(num & 0xffn));
    num >>= 8n;
  }

  // Leading '1' characters represent zero bytes
  const leadingZeros = str.split('').findIndex(c => c !== '1');
  const prefix = new Array(leadingZeros === -1 ? str.length : leadingZeros).fill(0);

  return new Uint8Array([...prefix, ...bytes]);
}
