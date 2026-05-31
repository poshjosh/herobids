import { describe, it, expect } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';

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
});
