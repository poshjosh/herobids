import { describe, expect, it, vi } from 'vitest';
import { AgentRepository } from '../agent-repository.js';

function buildMockDb(selectedRows: Array<Record<string, unknown>> = []) {
  const db = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(selectedRows),
          }),
        }),
      }),
    }),
  };
  return { db };
}

function makeRow(
  agentEmailEnabled: boolean | null | undefined,
  userEmailEnabled: boolean | null | undefined,
): Record<string, unknown> {
  return {
    agentNotificationPolicy:
      agentEmailEnabled !== undefined
        ? { sendMessage: { email: { enabled: agentEmailEnabled } } }
        : null,
    userNotificationPreferences:
      userEmailEnabled !== undefined
        ? { sendMessage: { email: { enabled: userEmailEnabled } } }
        : null,
  };
}

describe('AgentRepository.getEffectiveEmailEnabled — precedence rules', () => {
  it('returns false when agent explicit false overrides user explicit true', async () => {
    const { db } = buildMockDb([makeRow(false, true)]);
    const repo = new AgentRepository(db as never);
    expect(await repo.getEffectiveEmailEnabled('agent-1')).toBe(false);
  });

  it('returns true when agent explicit true overrides user explicit false', async () => {
    const { db } = buildMockDb([makeRow(true, false)]);
    const repo = new AgentRepository(db as never);
    expect(await repo.getEffectiveEmailEnabled('agent-1')).toBe(true);
  });

  it('returns true when agent has no policy and user explicit true', async () => {
    const { db } = buildMockDb([makeRow(undefined, true)]);
    const repo = new AgentRepository(db as never);
    expect(await repo.getEffectiveEmailEnabled('agent-1')).toBe(true);
  });

  it('returns false when agent has no policy and user explicit false', async () => {
    const { db } = buildMockDb([makeRow(undefined, false)]);
    const repo = new AgentRepository(db as never);
    expect(await repo.getEffectiveEmailEnabled('agent-1')).toBe(false);
  });

  it('returns true (system default) when both agent and user have no policy', async () => {
    const { db } = buildMockDb([makeRow(undefined, undefined)]);
    const repo = new AgentRepository(db as never);
    expect(await repo.getEffectiveEmailEnabled('agent-1')).toBe(true);
  });

  it('returns true (system default) when rows is empty (unknown agent)', async () => {
    const { db } = buildMockDb([]);
    const repo = new AgentRepository(db as never);
    expect(await repo.getEffectiveEmailEnabled('agent-unknown')).toBe(true);
  });
});
