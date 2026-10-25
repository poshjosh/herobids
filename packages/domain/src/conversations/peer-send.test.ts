import { describe, expect, it, vi } from 'vitest';
import { canPeerSend, type AgentOwnerLookup } from './peer-send.js';

function lookup(owners: Record<string, string>) {
  return { getAgent: vi.fn(async (id: string) => (id in owners ? { userId: owners[id]! } : null)) } satisfies AgentOwnerLookup;
}

describe('canPeerSend', () => {
  it('allows two agents of the same user', async () => {
    expect(await canPeerSend(lookup({ a1: 'u1', a2: 'u1' }), 'a1', 'a2')).toBe(true);
  });

  it('refuses two agents of different users', async () => {
    expect(await canPeerSend(lookup({ a1: 'u1', a2: 'u2' }), 'a1', 'a2')).toBe(false);
  });

  it('returns false, not an error, when the sender is unknown', async () => {
    expect(await canPeerSend(lookup({ a2: 'u1' }), 'missing', 'a2')).toBe(false);
  });

  it('returns false, not an error, when the recipient is unknown', async () => {
    expect(await canPeerSend(lookup({ a1: 'u1' }), 'a1', 'missing')).toBe(false);
  });

  it('returns false when both agents are unknown', async () => {
    expect(await canPeerSend(lookup({}), 'x', 'y')).toBe(false);
  });

  it('allows an agent to send to itself', async () => {
    const agents = lookup({ a1: 'u1' });
    expect(await canPeerSend(agents, 'a1', 'a1')).toBe(true);
    expect(agents.getAgent).toHaveBeenCalledTimes(1);
  });

  it('returns false for an unknown agent sending to itself', async () => {
    expect(await canPeerSend(lookup({}), 'x', 'x')).toBe(false);
  });

  it('rejects when the lookup fails, so the caller cannot send', async () => {
    const agents = { getAgent: vi.fn(async () => { throw new Error('db down'); }) } satisfies AgentOwnerLookup;
    await expect(canPeerSend(agents, 'a1', 'a2')).rejects.toThrow('db down');
  });
});
