import { describe, expect, it } from 'vitest';
import { connectionReturnPath } from './connection-return-path.js';

describe('connectionReturnPath', () => {
  it('returns the requesting agent chat when agentId is present', () => {
    expect(connectionReturnPath('agent-123')).toBe('/agents?agent=agent-123');
  });

  it('falls back to the agents page when agentId is absent', () => {
    expect(connectionReturnPath(null)).toBe('/agents');
  });

  it('falls back to the agents page when agentId is empty', () => {
    expect(connectionReturnPath('')).toBe('/agents');
  });

  it('encodes characters that would change the query', () => {
    expect(connectionReturnPath('a/b?c&d')).toBe('/agents?agent=a%2Fb%3Fc%26d');
  });

  it('carries the approved request id so the chat can follow the resumption', () => {
    expect(connectionReturnPath('agent-123', { connectedRequestId: 'req-1' })).toBe('/agents?agent=agent-123&connected=req-1');
  });

  it('does not carry a request id for a closed or declined connection', () => {
    expect(connectionReturnPath('agent-123', { connectedRequestId: null })).toBe('/agents?agent=agent-123');
  });
});
