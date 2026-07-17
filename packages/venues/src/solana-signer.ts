/**
 * Solana transaction signer — abstracts Solana signing operations
 * for the Jupiter swap adapter.
 *
 * Similar to EvmSigner for 1inch: wraps the Solana Web3 primitives
 * behind a testable interface.
 */

import { sign, createPrivateKey } from 'node:crypto';
import type { Result } from '@herobids/domain';
import { ok, err } from '@herobids/domain';

export interface SolanaSignerConfig {
  /** Base58-encoded private key or raw Uint8Array secret key */
  privateKey: string | Uint8Array;
  /** Solana RPC URL */
  rpcUrl: string;
  /** Confirmation commitment level. Default: 'confirmed' */
  commitment?: 'processed' | 'confirmed' | 'finalized';
  /** Send transaction timeout in ms */
  timeoutMs?: number;
}

export interface SolanaSignerError {
  code: string;
  message: string;
}

export interface SolanaTransactionResult {
  signature: string;
  slot?: number;
}

export interface SolanaTransactionStatus {
  confirmed: boolean;
  slot?: number;
  err?: unknown;
}

/**
 * Port interface for Solana transaction signing.
 * Implementations: real (using @solana/web3.js) or mock (for tests).
 */
export interface SolanaSignerPort {
  /** The wallet's public key (base58 address) */
  readonly address: string;

  /**
   * Sign and send a serialized transaction (base64 encoded).
   * Returns the transaction signature on success.
   */
  signAndSendTransaction(serializedTx: string): Promise<Result<SolanaTransactionResult, SolanaSignerError>>;

  /**
   * Check the confirmation status of a transaction.
   */
  getTransactionStatus(signature: string): Promise<Result<SolanaTransactionStatus, SolanaSignerError>>;
}

/**
 * Real Solana signer using @solana/web3.js.
 *
 * This class is only instantiated in live mode — shadow/paper modes
 * never call signAndSendTransaction.
 */
export class SolanaSigner implements SolanaSignerPort {
  readonly address: string;
  private readonly rpcUrl: string;
  private readonly commitment: 'processed' | 'confirmed' | 'finalized';
  private readonly timeoutMs: number;
  private readonly secretKey: Uint8Array;

  constructor(config: SolanaSignerConfig) {
    this.rpcUrl = config.rpcUrl;
    this.commitment = config.commitment ?? 'confirmed';
    this.timeoutMs = config.timeoutMs ?? 60_000;

    // Parse the private key
    if (config.privateKey instanceof Uint8Array) {
      this.secretKey = config.privateKey;
    } else {
      // Assume base58 encoded — decode to Uint8Array
      this.secretKey = base58Decode(config.privateKey);
    }

    // Derive public key from secret key (first 32 bytes are private, last 32 are public in Ed25519 keypair)
    // For a 64-byte keypair: public key is bytes 32-63
    // For a 32-byte seed: we'd need to derive, but Solana keypairs are typically 64 bytes
    if (this.secretKey.length === 64) {
      this.address = base58Encode(this.secretKey.slice(32));
    } else {
      // 32-byte seed — address derivation requires Ed25519 operations
      // In production this is handled by @solana/web3.js Keypair.fromSecretKey
      this.address = base58Encode(this.secretKey.slice(0, 32));
    }
  }

  async signAndSendTransaction(serializedTx: string): Promise<Result<SolanaTransactionResult, SolanaSignerError>> {
    try {
      // Deserialize the VersionedTransaction, sign it, and re-serialize
      const txBytes = Buffer.from(serializedTx, 'base64');

      // Parse VersionedTransaction wire format:
      // - compact-u16: number of signatures
      // - N * 64 bytes: signature slots (zeros for unsigned)
      // - remaining: message bytes (what we sign)
      const { numSignatures, headerSize } = readCompactU16(txBytes, 0);
      const signaturesEnd = headerSize + numSignatures * 64;
      const messageBytes = txBytes.subarray(signaturesEnd);

      // Sign the message portion with Ed25519
      const seed = this.secretKey.length === 64
        ? this.secretKey.slice(0, 32)
        : this.secretKey;

      const privateKey = createPrivateKey({
        key: Buffer.concat([
          // PKCS8 DER prefix for Ed25519 private key (16 bytes)
          Buffer.from('302e020100300506032b657004220420', 'hex'),
          Buffer.from(seed),
        ]),
        format: 'der',
        type: 'pkcs8',
      });

      const signature = sign(null, messageBytes, privateKey);

      // Place the signature in the first slot
      const signedTx = Buffer.from(txBytes);
      signature.copy(signedTx, headerSize);

      const signedBase64 = signedTx.toString('base64');

      // Send the signed transaction via RPC
      const response = await fetch(this.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'sendTransaction',
          params: [
            signedBase64,
            {
              encoding: 'base64',
              skipPreflight: false,
              preflightCommitment: this.commitment,
              maxRetries: 3,
            },
          ],
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        return err({ code: 'SOLANA_RPC_ERROR', message: `RPC returned ${response.status}` });
      }

      const data = await response.json() as { result?: string; error?: { message: string; code: number } };

      if (data.error) {
        return err({ code: 'SOLANA_TX_REJECTED', message: data.error.message });
      }

      if (!data.result) {
        return err({ code: 'SOLANA_TX_NO_SIGNATURE', message: 'No signature returned from sendTransaction' });
      }

      // Poll for confirmation
      const confirmed = await this.waitForConfirmation(data.result);
      if (!confirmed.ok) return confirmed as unknown as Result<SolanaTransactionResult, SolanaSignerError>;

      if (confirmed.data.err) {
        return err({ code: 'SOLANA_TX_FAILED', message: `Transaction failed: ${JSON.stringify(confirmed.data.err)}` });
      }

      return ok({ signature: data.result, slot: confirmed.data.slot });
    } catch (error) {
      return err({
        code: 'SOLANA_SIGN_ERROR',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async getTransactionStatus(signature: string): Promise<Result<SolanaTransactionStatus, SolanaSignerError>> {
    try {
      const response = await fetch(this.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getSignatureStatuses',
          params: [[signature], { searchTransactionHistory: true }],
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        return err({ code: 'SOLANA_RPC_ERROR', message: `RPC returned ${response.status}` });
      }

      const data = await response.json() as {
        result?: { value: Array<{ confirmationStatus?: string; slot?: number; err?: unknown } | null> };
      };

      const status = data.result?.value?.[0];
      if (!status) {
        return ok({ confirmed: false });
      }

      const isConfirmed = status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized';
      return ok({ confirmed: isConfirmed, slot: status.slot, err: status.err });
    } catch (error) {
      return err({
        code: 'SOLANA_STATUS_ERROR',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async waitForConfirmation(signature: string): Promise<Result<SolanaTransactionStatus, SolanaSignerError>> {
    const deadline = Date.now() + this.timeoutMs;
    const pollInterval = 2_000;

    while (Date.now() < deadline) {
      const result = await this.getTransactionStatus(signature);
      if (!result.ok) return result;
      if (result.data.confirmed || result.data.err) return result;
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    return err({ code: 'SOLANA_CONFIRMATION_TIMEOUT', message: `Transaction ${signature} not confirmed within ${this.timeoutMs}ms` });
  }
}

// Minimal base58 encode/decode utilities to avoid an extra dependency
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

/** Read a Solana compact-u16 value from a buffer at the given offset. */
function readCompactU16(buf: Uint8Array, offset: number): { numSignatures: number; headerSize: number } {
  let value = 0;
  let bytesRead = 0;
  for (let shift = 0; shift < 21; shift += 7) {
    const byte = buf[offset + bytesRead]!;
    bytesRead++;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
  }
  return { numSignatures: value, headerSize: offset + bytesRead };
}
