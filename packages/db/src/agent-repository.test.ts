import { describe, expect, it, vi } from 'vitest';
import { AgentRepository } from './agent-repository.js';
import type { ProvidersYaml } from '@herobids/domain';

const mockProvidersYaml: ProvidersYaml = {
  providers: {
    openai: {
      catalogMode: 'static',
      models: {
        'gpt-4o': { inputUsdPerM: 2.5, outputUsdPerM: 10 },
        'gpt-4o-mini': { inputUsdPerM: 0.15, outputUsdPerM: 0.6 },
      },
    },
  },
};

function buildDb(aiModelConfig: unknown) {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ aiModelConfig }]),
        }),
      }),
    }),
  };
}

describe('AgentRepository.getUserAiModelConfig', () => {
  it('returns null for persisted settings that no longer match the catalog', async () => {
    const db = buildDb({ provider: 'openai', lightModel: 'claude-haiku-3-5', heavyModel: 'gpt-4o' });
    const repository = new AgentRepository(db as never, mockProvidersYaml);

    await expect(repository.getUserAiModelConfig('user-1')).resolves.toBeNull();
  });

  it('returns normalized settings for a valid persisted tuple', async () => {
    const db = buildDb({ provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' });
    const repository = new AgentRepository(db as never, mockProvidersYaml);

    await expect(repository.getUserAiModelConfig('user-1')).resolves.toEqual({
      provider: 'openai',
      lightModel: 'gpt-4o-mini',
      heavyModel: 'gpt-4o',
    });
  });

  it('returns null for persisted settings that still use the removed legacy shape', async () => {
    const db = buildDb({ primary: { provider: 'openai', model: 'gpt-4o' } });
    const repository = new AgentRepository(db as never, mockProvidersYaml);

    await expect(repository.getUserAiModelConfig('user-1')).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getUserEmailByAgentId
// ---------------------------------------------------------------------------

function buildSelectJoinDb(rows: Array<Record<string, unknown>>) {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(rows),
          }),
        }),
      }),
    }),
  };
}

describe('AgentRepository.getUserEmailByAgentId', () => {
  it('returns the owning user email when found', async () => {
    const db = buildSelectJoinDb([{ email: 'owner@example.com' }]);
    const repo = new AgentRepository(db as never);
    await expect(repo.getUserEmailByAgentId('agent-1')).resolves.toBe('owner@example.com');
  });

  it('returns null when no agent row exists', async () => {
    const db = buildSelectJoinDb([]);
    const repo = new AgentRepository(db as never);
    await expect(repo.getUserEmailByAgentId('agent-missing')).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// email delivery metadata methods
// ---------------------------------------------------------------------------

function buildUpdateDb() {
  const whereFn = vi.fn().mockResolvedValue(undefined);
  const setFn = vi.fn().mockReturnValue({ where: whereFn });
  const updateFn = vi.fn().mockReturnValue({ set: setFn });
  return { db: { update: updateFn }, setFn, whereFn };
}

describe('AgentRepository email delivery metadata', () => {
  it('markOutboundMessageEmailSent writes email_sent status and messageId', async () => {
    const { db, setFn } = buildUpdateDb();
    const repo = new AgentRepository(db as never);
    await repo.markOutboundMessageEmailSent('msg-1', 'resend-abc123');
    expect(setFn).toHaveBeenCalledWith(expect.objectContaining({
      emailDeliveryStatus: 'email_sent',
      emailMessageId: 'resend-abc123',
    }));
  });

  it('markOutboundMessageEmailSkipped writes the supplied reason string', async () => {
    const { db, setFn } = buildUpdateDb();
    const repo = new AgentRepository(db as never);
    await repo.markOutboundMessageEmailSkipped('msg-2', 'email_skipped_policy');
    expect(setFn).toHaveBeenCalledWith(expect.objectContaining({
      emailDeliveryStatus: 'email_skipped_policy',
    }));
  });

  it('markOutboundMessageEmailFailed writes email_failed_provider status and error', async () => {
    const { db, setFn } = buildUpdateDb();
    const repo = new AgentRepository(db as never);
    await repo.markOutboundMessageEmailFailed('msg-3', 'Provider returned 503');
    expect(setFn).toHaveBeenCalledWith(expect.objectContaining({
      emailDeliveryStatus: 'email_failed_provider',
      emailDeliveryError: 'Provider returned 503',
    }));
  });
});

// ---------------------------------------------------------------------------
// runtime session retirement
// ---------------------------------------------------------------------------

function buildRuntimeSessionUpdateDb(returningRows: Array<Record<string, unknown>> = [{ id: 'sess-1' }]) {
  const returningFn = vi.fn().mockResolvedValue(returningRows);
  const whereFn = vi.fn().mockReturnValue({ returning: returningFn });
  const setFn = vi.fn().mockReturnValue({ where: whereFn });
  const updateFn = vi.fn().mockReturnValue({ set: setFn });
  return { db: { update: updateFn }, setFn, returningFn };
}

function buildRuntimeSessionRetireDb() {
  const whereFn = vi.fn().mockResolvedValue(undefined);
  const setFn = vi.fn().mockReturnValue({ where: whereFn });
  const updateFn = vi.fn().mockReturnValue({ set: setFn });
  return { db: { update: updateFn }, setFn };
}

describe('AgentRepository runtime session retirement', () => {
  it('retires active sessions as stopped', async () => {
    const { db, setFn } = buildRuntimeSessionRetireDb();
    const repo = new AgentRepository(db as never);

    await repo.retireActiveSessionsWithStatus('agent-1', 'stopped', new Date('2026-06-15T00:00:00Z'));

    expect(setFn).toHaveBeenCalledWith(expect.objectContaining({ status: 'stopped', stoppedAt: expect.any(Date) }));
  });

  it('retires active sessions as crashed', async () => {
    const { db, setFn } = buildRuntimeSessionRetireDb();
    const repo = new AgentRepository(db as never);

    await repo.retireActiveSessionsWithStatus('agent-1', 'crashed', new Date('2026-06-15T00:00:00Z'));

    expect(setFn).toHaveBeenCalledWith(expect.objectContaining({ status: 'crashed', stoppedAt: expect.any(Date) }));
  });

  it('does not change already-terminal sessions when ending a session', async () => {
    const { db, setFn, returningFn } = buildRuntimeSessionUpdateDb([]);
    const repo = new AgentRepository(db as never);

    await expect(repo.markSessionEnded('sess-1', 'crashed', new Date('2026-06-15T00:00:00Z'))).resolves.toBe(false);

    expect(setFn).toHaveBeenCalledWith(expect.objectContaining({ status: 'crashed', stoppedAt: expect.any(Date) }));
    expect(returningFn).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getEffectiveTelegramChatId
// ---------------------------------------------------------------------------

describe('AgentRepository.getEffectiveTelegramChatId', () => {
  function buildJoinDb(row: Record<string, unknown> | null) {
    return {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue(row ? [row] : []),
            }),
          }),
        }),
      }),
    };
  }

  it('returns agent-level chat ID when configured', async () => {
    const db = buildJoinDb({
      agentTelegramChatId: '111111',
      userTelegramChatId: '222222',
    });
    const repo = new AgentRepository(db as never);
    await expect(repo.getEffectiveTelegramChatId('agent-1')).resolves.toBe('111111');
  });

  it('falls back to user-level chat ID when agent has none', async () => {
    const db = buildJoinDb({
      agentTelegramChatId: null,
      userTelegramChatId: '222222',
    });
    const repo = new AgentRepository(db as never);
    await expect(repo.getEffectiveTelegramChatId('agent-1')).resolves.toBe('222222');
  });

  it('returns null when neither agent nor user has a chat ID', async () => {
    const db = buildJoinDb({
      agentTelegramChatId: null,
      userTelegramChatId: null,
    });
    const repo = new AgentRepository(db as never);
    await expect(repo.getEffectiveTelegramChatId('agent-1')).resolves.toBeNull();
  });

  it('returns null when no matching agent row exists', async () => {
    const db = buildJoinDb(null);
    const repo = new AgentRepository(db as never);
    await expect(repo.getEffectiveTelegramChatId('agent-missing')).resolves.toBeNull();
  });

  it('falls through to user default when agent chat ID is empty string', async () => {
    const db = buildJoinDb({
      agentTelegramChatId: '',
      userTelegramChatId: '222222',
    });
    const repo = new AgentRepository(db as never);
    await expect(repo.getEffectiveTelegramChatId('agent-1')).resolves.toBe('222222');
  });

  it('falls through to user default when agent chat ID is whitespace-only', async () => {
    const db = buildJoinDb({
      agentTelegramChatId: '   ',
      userTelegramChatId: '222222',
    });
    const repo = new AgentRepository(db as never);
    await expect(repo.getEffectiveTelegramChatId('agent-1')).resolves.toBe('222222');
  });

  it('returns null when user chat ID is whitespace-only and agent has none', async () => {
    const db = buildJoinDb({
      agentTelegramChatId: null,
      userTelegramChatId: '   ',
    });
    const repo = new AgentRepository(db as never);
    await expect(repo.getEffectiveTelegramChatId('agent-1')).resolves.toBeNull();
  });

  it('returns null when both chat IDs are whitespace-only', async () => {
    const db = buildJoinDb({
      agentTelegramChatId: '  ',
      userTelegramChatId: '   ',
    });
    const repo = new AgentRepository(db as never);
    await expect(repo.getEffectiveTelegramChatId('agent-1')).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveAgentForTelegramReply
// ---------------------------------------------------------------------------

describe('AgentRepository.resolveAgentForTelegramReply', () => {
  function buildReplyDb(rows: Array<Record<string, unknown>>) {
    return {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue(rows),
            }),
          }),
        }),
      }),
    };
  }

  it('resolves agent and returns userId when message ID and chat ID match', async () => {
    const db = buildReplyDb([{ agentId: 'agent-1', agentName: 'Momo', status: 'active', userId: 'user-1' }]);
    const repo = new AgentRepository(db as never);
    await expect(repo.resolveAgentForTelegramReply('999', 'chat-a')).resolves.toEqual({
      agentId: 'agent-1',
      agentName: 'Momo',
      status: 'active',
      userId: 'user-1',
    });
  });

  it('returns null when no matching outbound message exists', async () => {
    const db = buildReplyDb([]);
    const repo = new AgentRepository(db as never);
    await expect(repo.resolveAgentForTelegramReply('999', 'chat-a')).resolves.toBeNull();
  });

  it('returns null when the message ID belongs to a different chat', async () => {
    // Telegram message IDs are scoped per chat.  The repository must filter
    // by chatId so a reply in chat A cannot accidentally resolve to an
    // outbound message sent to chat B that happens to share the same
    // Telegram message ID.
    const db = buildReplyDb([]);
    const repo = new AgentRepository(db as never);
    await expect(repo.resolveAgentForTelegramReply('888', 'chat-b')).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getUnifiedConfig — capabilityMode / hybridMode defaulting (004)
// ---------------------------------------------------------------------------

function buildUnifiedConfigDb(raw: Record<string, unknown> | null) {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(raw ? [{ unifiedConfig: raw }] : []),
        }),
      }),
    }),
  };
}

describe('AgentRepository.getUnifiedConfig (capabilityMode/hybridMode defaults)', () => {
  it('returns hybridMode: "mixed" when config has capabilityMode: "hybrid" but no hybridMode', async () => {
    const db = buildUnifiedConfigDb({ capabilityMode: 'hybrid', technical: { venue: 'hyperliquid' } });
    const repo = new AgentRepository(db as never);
    const result = await repo.getUnifiedConfig('agent-1');
    expect(result).toMatchObject({ capabilityMode: 'hybrid', hybridMode: 'mixed' });
  });

  it('does not stamp hybridMode on intelligence agents', async () => {
    const db = buildUnifiedConfigDb({ capabilityMode: 'intelligence', intelligence: { prompt: 'test' } });
    const repo = new AgentRepository(db as never);
    const result = await repo.getUnifiedConfig('agent-1');
    expect(result).toMatchObject({ capabilityMode: 'intelligence' });
    expect(result).not.toHaveProperty('hybridMode');
  });

  it('preserves explicit hybridMode: "scanner_gated" when already set', async () => {
    const db = buildUnifiedConfigDb({ capabilityMode: 'hybrid', hybridMode: 'scanner_gated', technical: {} });
    const repo = new AgentRepository(db as never);
    const result = await repo.getUnifiedConfig('agent-1');
    expect(result).toMatchObject({ capabilityMode: 'hybrid', hybridMode: 'scanner_gated' });
  });

  it('stamps capabilityMode: "hybrid" and hybridMode: "mixed" when config has technical but no capabilityMode', async () => {
    const db = buildUnifiedConfigDb({ technical: { venue: 'hyperliquid' } });
    const repo = new AgentRepository(db as never);
    const result = await repo.getUnifiedConfig('agent-1');
    expect(result).toMatchObject({ capabilityMode: 'hybrid', hybridMode: 'mixed' });
  });

  it('stamps capabilityMode: "intelligence" when config has no technical and no capabilityMode', async () => {
    const db = buildUnifiedConfigDb({ intelligence: { prompt: 'hello' } });
    const repo = new AgentRepository(db as never);
    const result = await repo.getUnifiedConfig('agent-1');
    expect(result).toMatchObject({ capabilityMode: 'intelligence' });
    expect(result).not.toHaveProperty('hybridMode');
  });

  it('returns null when there is no stored config', async () => {
    const db = buildUnifiedConfigDb(null);
    const repo = new AgentRepository(db as never);
    const result = await repo.getUnifiedConfig('agent-1');
    expect(result).toBeNull();
  });
});