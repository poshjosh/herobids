import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
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

// Email fanout from send_message has been removed (2026-07-17).
// These persistence methods are retained for historical audit but no longer written by runtime.
describe.skip('AgentRepository email delivery metadata', () => {
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
// activateAgentUnlessPaused (bug 2026-10-05/001)
// ---------------------------------------------------------------------------

function buildConditionalActivateDb(updatedRows: Array<{ status: string }>, currentStatus: string | null) {
  const returningFn = vi.fn().mockResolvedValue(updatedRows);
  const whereFn = vi.fn().mockReturnValue({ returning: returningFn });
  const setFn = vi.fn().mockReturnValue({ where: whereFn });
  const updateFn = vi.fn().mockReturnValue({ set: setFn });
  const select = vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(currentStatus === null ? [] : [{ status: currentStatus }]),
      }),
    }),
  });
  return { db: { update: updateFn, select }, setFn, whereFn };
}

function renderWhere(condition: unknown): { sql: string; params: unknown[] } {
  return new PgDialect().sqlToQuery(condition as SQL);
}

describe('AgentRepository.activateAgentUnlessPaused', () => {
  it('conditional activate does not overwrite paused', async () => {
    const { db, whereFn } = buildConditionalActivateDb([], 'paused');
    const repo = new AgentRepository(db as never);

    await expect(repo.activateAgentUnlessPaused('agent-1')).resolves.toBe('paused');

    const rendered = renderWhere(whereFn.mock.calls[0]?.[0]);
    expect(rendered.sql).toContain('<>');
    expect(rendered.params).toContain('paused');
  });

  it('conditional activate sets active from other statuses', async () => {
    const { db, setFn } = buildConditionalActivateDb([{ status: 'active' }], 'starting');
    const repo = new AgentRepository(db as never);

    await expect(repo.activateAgentUnlessPaused('agent-1')).resolves.toBe('active');
    expect(setFn).toHaveBeenCalledWith(expect.objectContaining({ status: 'active' }));
  });

  it('returns null when the agent row is missing', async () => {
    const { db } = buildConditionalActivateDb([], null);
    const repo = new AgentRepository(db as never);

    await expect(repo.activateAgentUnlessPaused('agent-1')).resolves.toBeNull();
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
// getEffectiveChatAddress
// ---------------------------------------------------------------------------

/** Each db.select() call resolves with the next queued result set. */
function buildSequencedDb(results: Array<Array<Record<string, unknown>>>) {
  const queue = [...results];
  return {
    select: vi.fn(() => {
      const rows = queue.shift() ?? [];
      const chain = {
        from: vi.fn(() => chain),
        innerJoin: vi.fn(() => chain),
        leftJoin: vi.fn(() => chain),
        where: vi.fn(() => Object.assign(Promise.resolve(rows), {
          limit: vi.fn().mockResolvedValue(rows),
        })),
      };
      return chain;
    }),
  };
}

/** Like buildSequencedDb, but also records select fields, join and where conditions so SQL filters can be asserted. */
function buildRecordingDb(results: Array<Array<Record<string, unknown>>>) {
  const queue = [...results];
  const selectFields: Array<Record<string, unknown>> = [];
  const joinConditions: unknown[] = [];
  const whereConditions: unknown[] = [];
  const db = {
    select: vi.fn((fields: Record<string, unknown>) => {
      selectFields.push(fields);
      const rows = queue.shift() ?? [];
      const chain = {
        from: vi.fn(() => chain),
        innerJoin: vi.fn((_table: unknown, condition: unknown) => {
          joinConditions.push(condition);
          return chain;
        }),
        leftJoin: vi.fn((_table: unknown, condition: unknown) => {
          joinConditions.push(condition);
          return chain;
        }),
        where: vi.fn((condition: unknown) => {
          whereConditions.push(condition);
          return Object.assign(Promise.resolve(rows), {
            limit: vi.fn().mockResolvedValue(rows),
          });
        }),
      };
      return chain;
    }),
  };
  return { db, joinConditions, whereConditions, selectFields };
}

describe('AgentRepository.getEffectiveChatAddress', () => {
  it('reads neutral rows with an exact active status predicate and no status filter in the join', async () => {
    const { db, joinConditions, selectFields } = buildRecordingDb([[]]);
    const repo = new AgentRepository(db as never);
    await repo.getEffectiveChatAddress('agent-1', 'telegram');
    const activePredicate = renderWhere(selectFields[0]?.isActive);
    expect(activePredicate.sql).toBe('"chat_addresses"."status" = $1');
    expect(activePredicate.params).toEqual(['active']);
    expect(renderWhere(joinConditions[0]).params).not.toContain('active');
  });

  it('scopes neutral rows to the agent owner via chat_addresses.userId = agents.userId', async () => {
    const { db, joinConditions } = buildRecordingDb([[]]);
    const repo = new AgentRepository(db as never);
    await repo.getEffectiveChatAddress('agent-1', 'telegram');
    expect(renderWhere(joinConditions[0]).sql).toContain('"chat_addresses"."user_id" = "agents"."user_id"');
  });

  it('blocks a revoked agent-level row instead of falling through to the user-level row', async () => {
    const db = buildSequencedDb([[
      { rowAgentId: 'agent-1', address: '111111', isActive: false },
      { rowAgentId: null, address: '222222', isActive: true },
    ]]);
    const repo = new AgentRepository(db as never);
    await expect(repo.getEffectiveChatAddress('agent-1', 'telegram')).resolves.toBeNull();
  });

  it('does not fall back to the legacy telegram chat ID when the agent-level row is revoked', async () => {
    const db = buildSequencedDb([
      [{ rowAgentId: 'agent-1', address: '111111', isActive: false }],
      [{ agentTelegramChatId: '999999', userTelegramChatId: null }],
    ]);
    const repo = new AgentRepository(db as never);
    await expect(repo.getEffectiveChatAddress('agent-1', 'telegram')).resolves.toBeNull();
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('does not fall back to the legacy telegram chat ID when the user-level row is revoked', async () => {
    const db = buildSequencedDb([
      [{ rowAgentId: null, address: '222222', isActive: false }],
      [{ agentTelegramChatId: '999999', userTelegramChatId: null }],
    ]);
    const repo = new AgentRepository(db as never);
    await expect(repo.getEffectiveChatAddress('agent-1', 'telegram')).resolves.toBeNull();
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('returns null for a non-telegram provider when the only chat_addresses row is revoked', async () => {
    const db = buildSequencedDb([[{ rowAgentId: null, address: '+15555550100', isActive: false }]]);
    const repo = new AgentRepository(db as never);
    await expect(repo.getEffectiveChatAddress('agent-1', 'whatsapp')).resolves.toBeNull();
  });

  it('never returns a pending_optin row and reads only the exact active predicate', async () => {
    const { db, selectFields } = buildRecordingDb([[{ rowAgentId: null, address: '+15555550100', isActive: false }]]);
    const repo = new AgentRepository(db as never);
    await expect(repo.getEffectiveChatAddress('agent-1', 'sms')).resolves.toBeNull();
    const activePredicate = renderWhere(selectFields[0]?.isActive);
    expect(activePredicate.params).toEqual(['active']);
    expect(activePredicate.params).not.toContain('pending_optin');
  });

  it('returns the chat_addresses address when only neutral data exists', async () => {
    const db = buildSequencedDb([[{ rowAgentId: null, address: '333333', isActive: true }]]);
    const repo = new AgentRepository(db as never);
    await expect(repo.getEffectiveChatAddress('agent-1', 'telegram')).resolves.toEqual({
      provider: 'telegram',
      address: '333333',
    });
  });

  it('returns the agent-level chat_addresses override over the user-level default', async () => {
    const db = buildSequencedDb([[
      { rowAgentId: null, address: '222222', isActive: true },
      { rowAgentId: 'agent-1', address: '111111', isActive: true },
    ]]);
    const repo = new AgentRepository(db as never);
    await expect(repo.getEffectiveChatAddress('agent-1', 'telegram')).resolves.toEqual({
      provider: 'telegram',
      address: '111111',
    });
  });

  it('prefers the neutral address over a different legacy telegram chat ID', async () => {
    const db = buildSequencedDb([
      [{ agentTelegramChatId: null, rowAgentId: null, address: '222222', isActive: true }],
      [{ agentTelegramChatId: null, userTelegramChatId: '999999' }],
    ]);
    const repo = new AgentRepository(db as never);
    await expect(repo.getEffectiveChatAddress('agent-1', 'telegram')).resolves.toEqual({
      provider: 'telegram',
      address: '222222',
    });
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('returns the legacy agent-level telegram chat ID when no neutral row exists', async () => {
    const db = buildSequencedDb([
      [{ agentTelegramChatId: '111111', rowAgentId: null, address: null, isActive: null }],
    ]);
    const repo = new AgentRepository(db as never);
    await expect(repo.getEffectiveChatAddress('agent-1', 'telegram')).resolves.toEqual({
      provider: 'telegram',
      address: '111111',
    });
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('returns the legacy user-level telegram chat ID when only the user has one', async () => {
    const db = buildSequencedDb([
      [{ agentTelegramChatId: null, rowAgentId: null, address: null, isActive: null }],
      [{ agentTelegramChatId: null, userTelegramChatId: '222222' }],
    ]);
    const repo = new AgentRepository(db as never);
    await expect(repo.getEffectiveChatAddress('agent-1', 'telegram')).resolves.toEqual({
      provider: 'telegram',
      address: '222222',
    });
  });

  it('treats a whitespace-only neutral address as unset and uses the legacy chat ID', async () => {
    const db = buildSequencedDb([
      [{ rowAgentId: 'agent-1', address: '   ', isActive: true }],
      [{ agentTelegramChatId: null, userTelegramChatId: '222222' }],
    ]);
    const repo = new AgentRepository(db as never);
    await expect(repo.getEffectiveChatAddress('agent-1', 'telegram')).resolves.toEqual({
      provider: 'telegram',
      address: '222222',
    });
  });

  it('returns null for telegram when neither neutral nor legacy data exists', async () => {
    const db = buildSequencedDb([
      [],
      [{ agentTelegramChatId: null, userTelegramChatId: null }],
    ]);
    const repo = new AgentRepository(db as never);
    await expect(repo.getEffectiveChatAddress('agent-1', 'telegram')).resolves.toBeNull();
  });

  it('returns null for a non-telegram provider without a chat_addresses row, ignoring legacy columns', async () => {
    const db = buildSequencedDb([
      [],
      [{ agentTelegramChatId: '111111', userTelegramChatId: '222222' }],
    ]);
    const repo = new AgentRepository(db as never);
    await expect(repo.getEffectiveChatAddress('agent-1', 'sms')).resolves.toBeNull();
  });

  it('returns the neutral address for a non-telegram provider', async () => {
    const db = buildSequencedDb([[{ rowAgentId: null, address: '+15555550100', isActive: true }]]);
    const repo = new AgentRepository(db as never);
    await expect(repo.getEffectiveChatAddress('agent-1', 'sms')).resolves.toEqual({
      provider: 'sms',
      address: '+15555550100',
    });
  });

  it('ignores the agent legacy telegram chat ID for a non-telegram provider', async () => {
    const db = buildSequencedDb([[
      { agentTelegramChatId: '8681143261', rowAgentId: null, address: '+15555550100', isActive: true },
    ]]);
    const repo = new AgentRepository(db as never);
    await expect(repo.getEffectiveChatAddress('agent-1', 'sms')).resolves.toEqual({
      provider: 'sms',
      address: '+15555550100',
    });
  });

  it('uses the agent legacy telegram chat ID over an active user-level neutral row', async () => {
    const db = buildSequencedDb([[
      { agentTelegramChatId: '8681143261', rowAgentId: null, address: '6846862012', isActive: true },
    ]]);
    const repo = new AgentRepository(db as never);
    await expect(repo.getEffectiveChatAddress('agent-1', 'telegram')).resolves.toEqual({
      provider: 'telegram',
      address: '8681143261',
    });
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('prefers the agent-level neutral row over the agent legacy telegram chat ID', async () => {
    const db = buildSequencedDb([[
      { agentTelegramChatId: '8681143261', rowAgentId: 'agent-1', address: '111111', isActive: true },
      { agentTelegramChatId: '8681143261', rowAgentId: null, address: '222222', isActive: true },
    ]]);
    const repo = new AgentRepository(db as never);
    await expect(repo.getEffectiveChatAddress('agent-1', 'telegram')).resolves.toEqual({
      provider: 'telegram',
      address: '111111',
    });
  });

  it('returns null for telegram when the agent-level neutral row is revoked even with an agent legacy chat ID', async () => {
    const db = buildSequencedDb([[
      { agentTelegramChatId: '8681143261', rowAgentId: 'agent-1', address: '111111', isActive: false },
      { agentTelegramChatId: '8681143261', rowAgentId: null, address: '222222', isActive: true },
    ]]);
    const repo = new AgentRepository(db as never);
    await expect(repo.getEffectiveChatAddress('agent-1', 'telegram')).resolves.toBeNull();
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('uses the user-level neutral row when the agent has no legacy telegram chat ID', async () => {
    const db = buildSequencedDb([[
      { agentTelegramChatId: null, rowAgentId: null, address: '222222', isActive: true },
    ]]);
    const repo = new AgentRepository(db as never);
    await expect(repo.getEffectiveChatAddress('agent-1', 'telegram')).resolves.toEqual({
      provider: 'telegram',
      address: '222222',
    });
  });

  it('ignores a blank agent legacy telegram chat ID and uses the user-level neutral row', async () => {
    const db = buildSequencedDb([[
      { agentTelegramChatId: '   ', rowAgentId: null, address: '222222', isActive: true },
    ]]);
    const repo = new AgentRepository(db as never);
    await expect(repo.getEffectiveChatAddress('agent-1', 'telegram')).resolves.toEqual({
      provider: 'telegram',
      address: '222222',
    });
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
// resolveAgentForChatReply
// ---------------------------------------------------------------------------

describe('AgentRepository.resolveAgentForChatReply', () => {
  const agentOne = { agentId: 'agent-1', agentName: 'Momo', status: 'active', userId: 'user-1' };
  const agentTwo = { agentId: 'agent-2', agentName: 'Kofi', status: 'active', userId: 'user-1' };
  // Rows from the chat_addresses lookup carry whether that address row is active.
  const activeAddressOne = { ...agentOne, isAddressActive: true };
  const activeAddressTwo = { ...agentTwo, isAddressActive: true };
  const activeScope = { rowAgentId: 'agent-1', address: '111111', isActive: true };
  const blockedScope = { rowAgentId: 'agent-1', address: '111111', isActive: false };

  it('resolves the agent from a neutral agent-level address without a message ID', async () => {
    const db = buildSequencedDb([[activeAddressOne]]);
    const repo = new AgentRepository(db as never);
    await expect(repo.resolveAgentForChatReply('telegram', 'chat-a')).resolves.toEqual(agentOne);
  });

  it('returns null for a user-level address when no message ID is given', async () => {
    const db = buildSequencedDb([[]]);
    const repo = new AgentRepository(db as never);
    await expect(repo.resolveAgentForChatReply('telegram', 'chat-a')).resolves.toBeNull();
  });

  it('resolves the agent from neutral outbound delivery columns when only neutral data exists', async () => {
    const db = buildSequencedDb([[agentOne], [activeScope]]);
    const repo = new AgentRepository(db as never);
    await expect(repo.resolveAgentForChatReply('whatsapp', '+15555550100', 'wamid-1')).resolves.toEqual(agentOne);
  });

  it('resolves the agent from the legacy telegram pair when only legacy data exists', async () => {
    const db = buildSequencedDb([[], [], [agentOne]]);
    const repo = new AgentRepository(db as never);
    await expect(repo.resolveAgentForChatReply('telegram', 'chat-a', '999')).resolves.toEqual(agentOne);
  });

  it('does not use legacy telegram columns for a non-telegram provider', async () => {
    const db = buildSequencedDb([[], [], [agentOne]]);
    const repo = new AgentRepository(db as never);
    await expect(repo.resolveAgentForChatReply('sms', '+15555550100', '999')).resolves.toBeNull();
  });

  it('prefers the message ID match over an agent-level address', async () => {
    const db = buildSequencedDb([[agentOne], []]);
    const repo = new AgentRepository(db as never);
    await expect(repo.resolveAgentForChatReply('telegram', 'chat-a', '999')).resolves.toEqual(agentOne);
  });

  it('prefers the agent-level address over the legacy telegram pair', async () => {
    const db = buildSequencedDb([[], [activeAddressTwo]]);
    const repo = new AgentRepository(db as never);
    await expect(repo.resolveAgentForChatReply('telegram', 'chat-a', '999')).resolves.toEqual(agentTwo);
  });

  it('prefers the neutral outbound delivery match over the legacy telegram pair', async () => {
    const db = buildSequencedDb([[agentOne], []]);
    const repo = new AgentRepository(db as never);
    await expect(repo.resolveAgentForChatReply('telegram', 'chat-a', '999')).resolves.toEqual(agentOne);
  });

  it('does not resolve an agent from a revoked or pending_optin address and reads only the exact active predicate', async () => {
    const { db, selectFields } = buildRecordingDb([[{ ...agentOne, isAddressActive: false }]]);
    const repo = new AgentRepository(db as never);
    await expect(repo.resolveAgentForChatReply('telegram', 'chat-a')).resolves.toBeNull();
    const activePredicate = renderWhere(selectFields[0]?.isAddressActive);
    expect(activePredicate.params).toEqual(['active']);
    expect(activePredicate.params).not.toContain('pending_optin');
  });

  it('a revoked agent-level row blocks the legacy telegram fallback for an inbound reply', async () => {
    const db = buildSequencedDb([[], [{ ...agentOne, isAddressActive: false }], [agentOne]]);
    const repo = new AgentRepository(db as never);
    await expect(repo.resolveAgentForChatReply('telegram', 'chat-a', '999')).resolves.toBeNull();
    expect(db.select).toHaveBeenCalledTimes(2);
  });

  it('a revoked user-level row blocks the legacy telegram fallback for an inbound reply', async () => {
    const revokedUserLevel = { agentId: null, agentName: null, status: null, userId: null, isAddressActive: false };
    // Queue: outbound lookup (no match), address lookup (revoked user-level row), legacy pair (would match).
    const db = buildSequencedDb([[], [revokedUserLevel], [agentOne]]);
    const repo = new AgentRepository(db as never);
    await expect(repo.resolveAgentForChatReply('telegram', 'chat-a', '999')).resolves.toBeNull();
    expect(db.select).toHaveBeenCalledTimes(2);
  });

  it('an active user-level row never resolves an agent', async () => {
    const activeUserLevel = { agentId: null, agentName: null, status: null, userId: null, isAddressActive: true };
    const db = buildSequencedDb([[activeUserLevel]]);
    const repo = new AgentRepository(db as never);
    await expect(repo.resolveAgentForChatReply('telegram', 'chat-a')).resolves.toBeNull();
  });

  it('scopes the chat_addresses lookup to the agent owner via chat_addresses.userId = agents.userId', async () => {
    const { db, joinConditions } = buildRecordingDb([[activeAddressOne]]);
    const repo = new AgentRepository(db as never);
    await repo.resolveAgentForChatReply('telegram', 'chat-a');
    expect(renderWhere(joinConditions[0]).sql).toContain('"chat_addresses"."user_id" = "agents"."user_id"');
  });

  it('a blocked outbound-agent scope returns null even when a providerMessageId matches', async () => {
    const db = buildSequencedDb([[agentOne], [blockedScope]]);
    const repo = new AgentRepository(db as never);
    await expect(repo.resolveAgentForChatReply('telegram', 'chat-a', '999')).resolves.toBeNull();
    expect(db.select).toHaveBeenCalledTimes(2);
  });

  it('a pending_optin outbound-agent scope also returns null when a providerMessageId matches', async () => {
    const db = buildSequencedDb([[agentOne], [{ rowAgentId: null, address: '222222', isActive: false }]]);
    const repo = new AgentRepository(db as never);
    await expect(repo.resolveAgentForChatReply('telegram', 'chat-a', '999')).resolves.toBeNull();
  });

  it('does not guess when an address is shared by several agent overrides and no message ID is given', async () => {
    const db = buildSequencedDb([[activeAddressOne, activeAddressTwo]]);
    const repo = new AgentRepository(db as never);
    await expect(repo.resolveAgentForChatReply('telegram', 'chat-a')).resolves.toBeNull();
  });

  it('trims the inbound address before matching', async () => {
    const { db, whereConditions } = buildRecordingDb([[activeAddressOne]]);
    const repo = new AgentRepository(db as never);
    await expect(repo.resolveAgentForChatReply('telegram', '  chat-a  ')).resolves.toEqual(agentOne);
    const { params } = renderWhere(whereConditions[0]);
    expect(params).toContain('chat-a');
    expect(params).not.toContain('  chat-a  ');
  });

  it('treats a blank inbound address as no address', async () => {
    const db = buildSequencedDb([]);
    const repo = new AgentRepository(db as never);
    await expect(repo.resolveAgentForChatReply('telegram', '   ', '999')).resolves.toBeNull();
    expect(db.select).not.toHaveBeenCalled();
  });

  it('returns null when no neutral or legacy data matches the reply', async () => {
    const db = buildSequencedDb([[], [], []]);
    const repo = new AgentRepository(db as never);
    await expect(repo.resolveAgentForChatReply('telegram', 'chat-a', '999')).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isChatAddressSuppressed
// ---------------------------------------------------------------------------

describe('AgentRepository.isChatAddressSuppressed', () => {
  it('returns true when another tenant holds a revoked or pending_optin row for the address', async () => {
    const db = buildSequencedDb([[{ id: 'row-revoked' }], [{ id: 'row-pending' }]]);
    const repo = new AgentRepository(db as never);
    await expect(repo.isChatAddressSuppressed('telegram', '123')).resolves.toBe(true);
    await expect(repo.isChatAddressSuppressed('telegram', '123')).resolves.toBe(true);
  });

  it('returns false when every row for the address is active', async () => {
    const db = buildSequencedDb([[]]);
    const repo = new AgentRepository(db as never);
    await expect(repo.isChatAddressSuppressed('telegram', '123')).resolves.toBe(false);
  });

  it('returns false when no row exists for the address', async () => {
    const db = buildSequencedDb([[]]);
    const repo = new AgentRepository(db as never);
    await expect(repo.isChatAddressSuppressed('whatsapp', '+15555550100')).resolves.toBe(false);
  });

  it('matches any non-active status across all users, on the trimmed address and provider only', async () => {
    const { db, whereConditions } = buildRecordingDb([[]]);
    const repo = new AgentRepository(db as never);
    await repo.isChatAddressSuppressed('telegram', '  123  ');
    const { sql: whereSql, params } = renderWhere(whereConditions[0]);
    expect(whereSql).toContain('"chat_addresses"."status" <> $3');
    expect(params).toEqual(['telegram', '123', 'active']);
    expect(whereSql).not.toContain('user_id');
    expect(whereSql).not.toContain('agent_id');
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

describe('AgentRepository.markOutboundMessageSent', () => {
  it('writes the legacy telegram pair and the neutral delivery columns in the same update', async () => {
    const { db, setFn } = buildUpdateDb();
    const repo = new AgentRepository(db as never);

    await repo.markOutboundMessageSent('msg-001', '42', '111111');

    expect(setFn).toHaveBeenCalledWith({
      deliveryStatus: 'sent',
      telegramMessageId: '42',
      telegramChatId: '111111',
      deliveryProvider: 'telegram',
      deliveryAddress: '111111',
      providerMessageId: '42',
    });
  });
});

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

// ---------------------------------------------------------------------------
// getUnifiedConfig — technical config defaults (001)
// ---------------------------------------------------------------------------

describe('AgentRepository.getUnifiedConfig — technical config defaults', () => {
  it('returns scanBatchSize=5 when technical config omits it', async () => {
    const db = buildUnifiedConfigDb({
      capabilityMode: 'hybrid',
      hybridMode: 'scanner_gated',
      technical: {
        filters: { venue: 'hyperliquid', venueType: 'orderbook' },
      },
    });
    const repo = new AgentRepository(db as never);
    const config = await repo.getUnifiedConfig('agent-1');
    expect(config).not.toBeNull();
    expect(config!.technical).toBeDefined();
    expect(config!.technical!.scanBatchSize).toBe(5);
    expect(config!.technical!.scanIntervalMs).toBe(60_000);
    expect(config!.technical!.candles).toEqual({ interval: '15m', limit: 100 });
    expect(config!.technical!.signalBias).toBe('trend-following');
    expect(config!.technical!.autonomousExit).toBe(false);
  });

  it('does not override explicitly-set values', async () => {
    const db = buildUnifiedConfigDb({
      capabilityMode: 'hybrid',
      hybridMode: 'scanner_gated',
      technical: {
        filters: { venue: 'hyperliquid', venueType: 'orderbook' },
        scanBatchSize: 10,
        scanIntervalMs: 30_000,
      },
    });
    const repo = new AgentRepository(db as never);
    const config = await repo.getUnifiedConfig('agent-1');
    expect(config!.technical!.scanBatchSize).toBe(10);
    expect(config!.technical!.scanIntervalMs).toBe(30_000);
  });

  it('returns undefined technical when technical is absent from stored config', async () => {
    const db = buildUnifiedConfigDb({
      capabilityMode: 'intelligence',
    });
    const repo = new AgentRepository(db as never);
    const config = await repo.getUnifiedConfig('agent-1');
    expect(config!.technical).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getUnifiedConfig — intelligence config defaults (001)
// ---------------------------------------------------------------------------

describe('AgentRepository.getUnifiedConfig — intelligence config defaults', () => {
  it('preserves intelligence config object when present but all fields are optional', async () => {
    const db = buildUnifiedConfigDb({
      capabilityMode: 'intelligence',
      intelligence: {},
    });
    const repo = new AgentRepository(db as never);
    const config = await repo.getUnifiedConfig('agent-1');
    expect(config!.intelligence).toBeDefined();
    // Fields with .optional() (no .default()) remain undefined — correct behavior
    expect(config!.intelligence!.wakeIntervalMs).toBeUndefined();
    expect(config!.intelligence!.maxTokens).toBeUndefined();
    expect(config!.intelligence!.provider).toBeUndefined();
    expect(config!.intelligence!.lightModel).toBeUndefined();
    expect(config!.intelligence!.heavyModel).toBeUndefined();
  });

  it('returns undefined when intelligence is absent', async () => {
    const db = buildUnifiedConfigDb({
      capabilityMode: 'intelligence',
    });
    const repo = new AgentRepository(db as never);
    const config = await repo.getUnifiedConfig('agent-1');
    expect(config!.intelligence).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// updateUnifiedConfig — hybridMode default stamping on write (004, B-M1)
// ---------------------------------------------------------------------------

describe('AgentRepository.updateUnifiedConfig (hybridMode write-path stamping)', () => {
  it('stamps hybridMode: "mixed" on write when hybrid agent has no hybridMode', async () => {
    const { db, setFn } = buildUpdateDb();
    const repo = new AgentRepository(db as never);
    await repo.updateUnifiedConfig('agent-1', {
      capabilityMode: 'hybrid',
      technical: { venue: 'hyperliquid' },
    } as never);
    expect(setFn).toHaveBeenCalledWith(expect.objectContaining({
      unifiedConfig: expect.objectContaining({
        capabilityMode: 'hybrid',
        hybridMode: 'mixed',
      }),
    }));
  });

  it('preserves explicit hybridMode: "scanner_gated" on write', async () => {
    const { db, setFn } = buildUpdateDb();
    const repo = new AgentRepository(db as never);
    await repo.updateUnifiedConfig('agent-1', {
      capabilityMode: 'hybrid',
      hybridMode: 'scanner_gated',
      technical: {},
    } as never);
    expect(setFn).toHaveBeenCalledWith(expect.objectContaining({
      unifiedConfig: expect.objectContaining({
        capabilityMode: 'hybrid',
        hybridMode: 'scanner_gated',
      }),
    }));
  });

  it('does not inject hybridMode on write for intelligence agents', async () => {
    const { db, setFn } = buildUpdateDb();
    const repo = new AgentRepository(db as never);
    await repo.updateUnifiedConfig('agent-1', {
      capabilityMode: 'intelligence',
      intelligence: { prompt: 'test' },
    } as never);
    expect(setFn).toHaveBeenCalledWith(expect.objectContaining({
      unifiedConfig: expect.not.objectContaining({ hybridMode: expect.anything() }),
    }));
  });

  it('handles null config (clearing unified config)', async () => {
    const { db, setFn } = buildUpdateDb();
    const repo = new AgentRepository(db as never);
    await repo.updateUnifiedConfig('agent-1', null);
    expect(setFn).toHaveBeenCalledWith(expect.objectContaining({
      unifiedConfig: null,
    }));
  });
});