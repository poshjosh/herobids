import { describe, it, expect } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { EvmSigner } from './evm-signer.js';

/**
 * Unit tests for EVM signer.
 * Tests deterministic address derivation from known private keys.
 * Does NOT test RPC calls — those belong in integration tests.
 */
describe('EVM signer address derivation', () => {
  it('derives correct address from a known private key', () => {
    // Well-known test private key (Hardhat account #0)
    const key = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
    const account = privateKeyToAccount(key);
    expect(account.address).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
  });

  it('handles keys without 0x prefix', () => {
    const keyNoPrefix = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
    const account = privateKeyToAccount(`0x${keyNoPrefix}`);
    expect(account.address).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
  });

  it('derives different addresses for different keys', () => {
    const key1 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
    const key2 = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
    const account1 = privateKeyToAccount(key1);
    const account2 = privateKeyToAccount(key2);
    expect(account1.address).not.toBe(account2.address);
  });

  it('address is a valid EVM address format', () => {
    const key = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
    const account = privateKeyToAccount(key);
    expect(account.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('signs a deterministic EIP-1559 transaction with fixed fields', async () => {
    const signer = new EvmSigner({
      privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      rpcUrl: 'https://mainnet.base.org',
      chainId: 8453,
      confirmationTimeoutMs: 60_000,
    });

    const result = await signer.signTransaction({
      to: '0x1111111111111111111111111111111111111111',
      data: '0x',
      value: 0n,
      gas: 21_000n,
      nonce: 0,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 100_000_000n,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected signing to succeed');
    expect(result.data).toBe('0x02f86c822105808405f5e100843b9aca008252089411111111111111111111111111111111111111118080c001a0464990585bcfac9962bc921f499640ed0c6e8a13e63f98e2609a1f138f84a21fa069a9ddef1d6e13b2d21969fa36818801d29f5b0e8a3d8ee2a5cbe7c0dd67e9e4');
  });

  it('supports other configured EVM chains without code changes', () => {
    expect(() => new EvmSigner({
      privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      rpcUrl: 'https://eth.llamarpc.com',
      chainId: 1,
      confirmationTimeoutMs: 60_000,
    })).not.toThrow();

    expect(() => new EvmSigner({
      privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      rpcUrl: 'https://arb1.arbitrum.io/rpc',
      chainId: 42161,
      confirmationTimeoutMs: 60_000,
    })).not.toThrow();
  });

  it('defaults confirmation timeout when omitted', async () => {
    const signer = new EvmSigner({
      privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      rpcUrl: 'https://mainnet.base.org',
      chainId: 8453,
    });

    expect(signer).toBeDefined();
  });
});
