import { describe, it, expect } from 'vitest';
import {
  generateConnectionOAuthState,
  verifyConnectionOAuthState,
} from './connections-oauth-state.js';

const SECRET = 'test-secret-key-32-bytes-long!!';
const USER_ID = '550e8400-e29b-41d4-a716-446655440000';

describe('generateConnectionOAuthState', () => {
  it('throws when userId is empty', () => {
    expect(() => generateConnectionOAuthState('', SECRET)).toThrow('userId and secret are required');
  });

  it('throws when secret is empty', () => {
    expect(() => generateConnectionOAuthState(USER_ID, '')).toThrow('userId and secret are required');
  });

  it('produces a different nonce on each call', () => {
    const a = generateConnectionOAuthState(USER_ID, SECRET);
    const b = generateConnectionOAuthState(USER_ID, SECRET);
    expect(a).not.toBe(b);
  });

  it('produces a token in the expected format (userId.nonce.signature)', () => {
    const token = generateConnectionOAuthState(USER_ID, SECRET);
    const parts = token.split('.');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe(USER_ID);
  });
});

describe('verifyConnectionOAuthState', () => {
  it('round-trip: valid token returns the correct userId', () => {
    const token = generateConnectionOAuthState(USER_ID, SECRET);
    const result = verifyConnectionOAuthState(token, token, SECRET);
    expect(result).toBe(USER_ID);
  });

  it('returns null when state is empty', () => {
    const token = generateConnectionOAuthState(USER_ID, SECRET);
    expect(verifyConnectionOAuthState('', token, SECRET)).toBeNull();
  });

  it('returns null when cookieState is empty', () => {
    const token = generateConnectionOAuthState(USER_ID, SECRET);
    expect(verifyConnectionOAuthState(token, '', SECRET)).toBeNull();
  });

  it('returns null when state and cookieState do not match', () => {
    const tokenA = generateConnectionOAuthState(USER_ID, SECRET);
    const tokenB = generateConnectionOAuthState(USER_ID, SECRET);
    expect(verifyConnectionOAuthState(tokenA, tokenB, SECRET)).toBeNull();
  });

  it('returns null when signature is tampered', () => {
    const token = generateConnectionOAuthState(USER_ID, SECRET);
    const parts = token.split('.');
    // Flip the last character of the signature
    const lastChar = parts[2]!.slice(-1);
    const flipped = lastChar === 'A' ? 'B' : 'A';
    const tampered = `${parts[0]}.${parts[1]}.${parts[2]!.slice(0, -1)}${flipped}`;
    expect(verifyConnectionOAuthState(tampered, tampered, SECRET)).toBeNull();
  });

  it('returns null when userId portion is altered (tampered userId)', () => {
    const token = generateConnectionOAuthState(USER_ID, SECRET);
    const parts = token.split('.');
    // Replace the userId with a different one but keep the same signature
    const tampered = `660e8400-e29b-41d4-a716-446655440001.${parts[1]}.${parts[2]}`;
    expect(verifyConnectionOAuthState(tampered, tampered, SECRET)).toBeNull();
  });

  it('returns null when verified with a different secret', () => {
    const token = generateConnectionOAuthState(USER_ID, SECRET);
    expect(verifyConnectionOAuthState(token, token, 'different-secret-key-here!!')).toBeNull();
  });

  it('returns null when the state string has no dots', () => {
    expect(verifyConnectionOAuthState('nodotshere', 'nodotshere', SECRET)).toBeNull();
  });

  it('returns null when the state string has only one dot', () => {
    expect(verifyConnectionOAuthState('user.sig', 'user.sig', SECRET)).toBeNull();
  });
});
