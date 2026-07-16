import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { SolanaSigner } from './solana-signer.js';
import { generateWallet, WalletGenerationError } from './wallet-generation.js';

describe('generateWallet', () => {
  it('maps a Hyperliquid wallet to direct main-wallet credentials', () => {
    const result = generateWallet({ provider: 'hyperliquid', enabled: true, network: 'Hyperliquid' });

    expect(result.wallet).toMatchObject({ provider: 'hyperliquid', custodyMode: 'direct', network: 'Hyperliquid' });
    expect(result.wallet.address).toMatch(/^0x[0-9a-f]{40}$/i);
    expect(result.secrets).toEqual({
      apiKey: result.wallet.address,
      secret: (result.secrets as { secret: string }).secret,
      walletAddress: result.wallet.address,
    });
    expect(privateKeyToAccount((result.secrets as { secret: `0x${string}` }).secret).address).toBe(result.wallet.address);
  });

  it('generates a Jupiter secret that round-trips through SolanaSigner', () => {
    const result = generateWallet({ provider: 'jupiter', enabled: true, network: 'Solana' });
    const secret = result.secrets as { privateKey: string };

    expect(result.wallet).toMatchObject({ provider: 'jupiter', custodyMode: 'direct', network: 'Solana' });
    expect(result.wallet.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
    expect(new SolanaSigner({ privateKey: secret.privateKey, rpcUrl: 'https://api.mainnet-beta.solana.com' }).address)
      .toBe(result.wallet.address);
  });

  it('maps a 1inch wallet to an EVM signing private key', () => {
    const result = generateWallet({ provider: '1inch', enabled: true, network: 'Base' });
    const secret = result.secrets as { privateKey: `0x${string}` };

    expect(result.wallet).toMatchObject({ provider: '1inch', custodyMode: 'direct', network: 'Base' });
    expect(privateKeyToAccount(secret.privateKey).address).toBe(result.wallet.address);
  });

  it('keeps generated secrets out of the public wallet data', () => {
    const result = generateWallet({ provider: '1inch', enabled: true, network: 'Base' });

    expect(JSON.stringify(result.wallet)).not.toContain((result.secrets as { privateKey: string }).privateKey);
    expect(result.wallet).not.toHaveProperty('privateKey');
    expect(result.wallet).not.toHaveProperty('secret');
  });

  it('rejects unsupported and disabled generation', () => {
    expect(() => generateWallet({ provider: 'bybit', enabled: true, network: 'Bybit' }))
      .toThrow(WalletGenerationError);
    expect(() => generateWallet({ provider: 'jupiter', enabled: false, network: 'Solana' }))
      .toThrow(WalletGenerationError);
  });
});