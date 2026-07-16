import { createPrivateKey, createPublicKey, randomBytes } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

export const WALLET_GENERATION_PROVIDERS = ['hyperliquid', 'jupiter', '1inch'] as const;
export type WalletGenerationProvider = typeof WALLET_GENERATION_PROVIDERS[number];

export interface GeneratedWalletPublic {
  provider: WalletGenerationProvider;
  custodyMode: 'direct';
  address: string;
  network: string;
}

export type GeneratedWalletSecrets =
  | { apiKey: string; secret: string; walletAddress: string }
  | { privateKey: string };

export interface WalletGenerationResult {
  wallet: GeneratedWalletPublic;
  secrets: GeneratedWalletSecrets;
}

export interface WalletGenerationRequest {
  provider: string;
  enabled: boolean;
  network: string;
}

export class WalletGenerationError extends Error {
  constructor(
    public readonly code: 'wallet_generation.unsupported_provider' | 'wallet_generation.disabled',
    message: string,
  ) {
    super(message);
  }
}

export function generateWallet(request: WalletGenerationRequest): WalletGenerationResult {
  if (!WALLET_GENERATION_PROVIDERS.includes(request.provider as WalletGenerationProvider)) {
    throw new WalletGenerationError(
      'wallet_generation.unsupported_provider',
      `Wallet generation is not supported for provider ${request.provider}`,
    );
  }
  if (!request.enabled) {
    throw new WalletGenerationError(
      'wallet_generation.disabled',
      `Wallet generation is disabled for provider ${request.provider}`,
    );
  }

  const provider = request.provider as WalletGenerationProvider;
  if (provider === 'jupiter') {
    const { address, privateKey } = generateSolanaWallet();
    return {
      wallet: { provider, custodyMode: 'direct', address, network: request.network },
      secrets: { privateKey },
    };
  }

  const privateKey = generatePrivateKey();
  const address = privateKeyToAccount(privateKey).address;
  if (provider === 'hyperliquid') {
    return {
      wallet: { provider, custodyMode: 'direct', address, network: request.network },
      secrets: { apiKey: address, secret: privateKey, walletAddress: address },
    };
  }

  return {
    wallet: { provider, custodyMode: 'direct', address, network: request.network },
    secrets: { privateKey },
  };
}

function generateSolanaWallet(): { address: string; privateKey: string } {
  const seed = randomBytes(32);
  const privateKey = createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      seed,
    ]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);
  const secretKey = new Uint8Array(64);
  secretKey.set(seed, 0);
  secretKey.set(publicKey, 32);

  return {
    address: base58Encode(publicKey),
    privateKey: base58Encode(secretKey),
  };
}

const BASE58_CHARS = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(bytes: Uint8Array): string {
  let num = 0n;
  for (const byte of bytes) {
    num = num * 256n + BigInt(byte);
  }

  let result = '';
  while (num > 0n) {
    const remainder = Number(num % 58n);
    num /= 58n;
    result = BASE58_CHARS[remainder]! + result;
  }

  for (const byte of bytes) {
    if (byte === 0) result = `1${result}`;
    else break;
  }

  return result || '1';
}