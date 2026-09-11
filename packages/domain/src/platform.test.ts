import { describe, it, expect } from 'vitest';
import {
  credentialCreatedEvent,
  credentialRotatedEvent,
  credentialDeletedEvent,
} from './platform.js';

// L3d-1: these platform audit-event builders were relocated from
// @herobids/engine (journal.ts) so they survive the engine deletion. Tests moved
// here with them.
describe('credential audit event builders', () => {
  it('credentialCreatedEvent produces the correct shape without secrets', () => {
    const entry = credentialCreatedEvent({
      credentialId: 'cred-1',
      venue: 'hyperliquid',
      userId: 'user-1',
      label: 'prod-key',
    });
    expect(entry.type).toBe('credential.created');
    expect(entry.payload).toMatchObject({
      credentialId: 'cred-1',
      venue: 'hyperliquid',
      userId: 'user-1',
      label: 'prod-key',
    });
    // No secret material should ever be carried in an audit event payload.
    expect(JSON.stringify(entry)).not.toContain('secret');
  });

  it('credentialRotatedEvent produces the correct shape', () => {
    const entry = credentialRotatedEvent({
      credentialId: 'cred-2',
      venue: 'hyperliquid',
      userId: 'user-1',
    });
    expect(entry.type).toBe('credential.rotated');
    expect(entry.payload.credentialId).toBe('cred-2');
    expect(entry.payload.venue).toBe('hyperliquid');
  });

  it('credentialRotatedEvent omits userId when not provided', () => {
    const entry = credentialRotatedEvent({
      credentialId: 'cred-2b',
      venue: 'bybit',
    });
    expect(entry.type).toBe('credential.rotated');
    expect(entry.payload.userId).toBeUndefined();
  });

  it('credentialDeletedEvent produces the correct shape', () => {
    const entry = credentialDeletedEvent({
      credentialId: 'cred-3',
      venue: 'hyperliquid',
      userId: 'user-2',
    });
    expect(entry.type).toBe('credential.deleted');
    expect(entry.payload.credentialId).toBe('cred-3');
  });
});
