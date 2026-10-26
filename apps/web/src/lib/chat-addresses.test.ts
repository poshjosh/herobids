import { describe, expect, it } from 'vitest';
import { chatAddressFor } from './chat-addresses.js';

describe('chatAddressFor', () => {
  it('returns the active address of the requested provider', () => {
    expect(chatAddressFor([
      { provider: 'sms', address: '+15555550100', scope: 'user', status: 'active' },
      { provider: 'telegram', address: '5550001', scope: 'user', status: 'active' },
    ], 'telegram')).toBe('5550001');
  });

  it('returns an empty string when the list is missing, empty, or has only inactive rows', () => {
    expect(chatAddressFor(undefined, 'telegram')).toBe('');
    expect(chatAddressFor([], 'telegram')).toBe('');
    expect(chatAddressFor([{ provider: 'telegram', address: '1', scope: 'user', status: 'revoked' }], 'telegram')).toBe('');
  });
});
