import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { getTableName } from 'drizzle-orm';
import { AgentRepository, setChatAddress, revokeChatAddress, listChatAddressesForOutput } from './agent-repository.js';
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

function buildUpdateDb() {
  const whereFn = vi.fn().mockResolvedValue(undefined);
  const setFn = vi.fn().mockReturnValue({ where: whereFn });
  const updateFn = vi.fn().mockReturnValue({ set: setFn });
  return { db: { update: updateFn }, setFn, whereFn };
}

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
// chat addresses (neutral chat_addresses and chat_suppressions rows)
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
          orderBy: vi.fn(() => Object.assign(Promise.resolve(rows), { limit: vi.fn().mockResolvedValue(rows) })),
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
            orderBy: vi.fn(() => Object.assign(Promise.resolve(rows), { limit: vi.fn().mockResolvedValue(rows) })),
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

  it('returns the user-level address when the agent has no override', async () => {
    const db = buildSequencedDb([[{ rowAgentId: null, address: '222222', isActive: true }]]);
    const repo = new AgentRepository(db as never);
    await expect(repo.getEffectiveChatAddress('agent-1', 'telegram')).resolves.toEqual({
      provider: 'telegram',
      address: '222222',
    });
  });

  it('returns the agent-level override over the user-level default', async () => {
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

  it('returns null when no row exists', async () => {
    const db = buildSequencedDb([[]]);
    const repo = new AgentRepository(db as never);
    await expect(repo.getEffectiveChatAddress('agent-1', 'telegram')).resolves.toBeNull();
  });

  it('returns the neutral address for a non-telegram provider', async () => {
    const db = buildSequencedDb([[{ rowAgentId: null, address: '+15555550100', isActive: true }]]);
    const repo = new AgentRepository(db as never);
    await expect(repo.getEffectiveChatAddress('agent-1', 'whatsapp')).resolves.toEqual({
      provider: 'whatsapp',
      address: '+15555550100',
    });
  });

  it('blocks a non-active agent-level row instead of falling through to the user-level row', async () => {
    const db = buildSequencedDb([[
      { rowAgentId: 'agent-1', address: '111111', isActive: false },
      { rowAgentId: null, address: '222222', isActive: true },
    ]]);
    const repo = new AgentRepository(db as never);
    await expect(repo.getEffectiveChatAddress('agent-1', 'telegram')).resolves.toBeNull();
  });

  it('returns null when the chosen user-level row is not active', async () => {
    const db = buildSequencedDb([[{ rowAgentId: null, address: '222222', isActive: false }]]);
    const repo = new AgentRepository(db as never);
    await expect(repo.getEffectiveChatAddress('agent-1', 'telegram')).resolves.toBeNull();
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
  const noSuppression: Array<Record<string, unknown>> = [];
  const suppression = [{ address: 'chat-a' }];

  it('resolves the agent from an agent-level address without a message ID', async () => {
    const db = buildSequencedDb([noSuppression, [activeAddressOne]]);
    const repo = new AgentRepository(db as never);
    await expect(repo.resolveAgentForChatReply('telegram', 'chat-a')).resolves.toEqual(agentOne);
  });

  it('returns null for a user-level address when no message ID is given', async () => {
    const db = buildSequencedDb([noSuppression, []]);
    const repo = new AgentRepository(db as never);
    await expect(repo.resolveAgentForChatReply('telegram', 'chat-a')).resolves.toBeNull();
  });

  it('resolves the agent from the conversation message the reply points at', async () => {
    const db = buildSequencedDb([noSuppression, [agentOne]]);
    const repo = new AgentRepository(db as never);
    await expect(repo.resolveAgentForChatReply('telegram', 'chat-a', '999')).resolves.toEqual(agentOne);
    expect(db.select).toHaveBeenCalledTimes(2);
  });

  it('skips the message lookup for a provider that is not a thread channel', async () => {
    const db = buildSequencedDb([noSuppression, [activeAddressOne]]);
    const repo = new AgentRepository(db as never);
    await expect(repo.resolveAgentForChatReply('whatsapp', '+15555550100', 'wamid-1')).resolves.toEqual(agentOne);
    expect(db.select).toHaveBeenCalledTimes(2);
  });

  it('puts the address, active status, rebind and shadowing predicates in the message lookup SQL', async () => {
    const { db, joinConditions, whereConditions } = buildRecordingDb([noSuppression, [agentOne]]);
    const repo = new AgentRepository(db as never);
    await repo.resolveAgentForChatReply('telegram', 'chat-a', '999');
    const addressJoin = renderWhere(joinConditions.find((c) => renderWhere(c).sql.includes('"chat_addresses"."address"'))).sql;
    expect(addressJoin).toContain('"chat_addresses"."address" = $');
    expect(addressJoin).toContain('"chat_addresses"."status" = $');
    expect(addressJoin).toContain('"chat_addresses"."user_id" = "agents"."user_id"');
    expect(addressJoin).toContain('"chat_addresses"."updated_at" <= "conversation_messages"."created_at"');
    const messageWhere = renderWhere(whereConditions[1]);
    expect(messageWhere.sql).toContain('"conversation_messages"."channel" = $');
    expect(messageWhere.sql).toContain('"agent_override"."id" is null');
    expect(messageWhere.params).toEqual(expect.arrayContaining(['telegram', '999', 'user_agent']));
  });

  it('falls back to the agent-level address when the message ID matches no conversation message', async () => {
    const db = buildSequencedDb([noSuppression, [], [activeAddressTwo]]);
    const repo = new AgentRepository(db as never);
    await expect(repo.resolveAgentForChatReply('telegram', 'chat-a', '999')).resolves.toEqual(agentTwo);
  });

  it('returns null when neither a conversation message nor an address row match the reply', async () => {
    const db = buildSequencedDb([noSuppression, [], []]);
    const repo = new AgentRepository(db as never);
    await expect(repo.resolveAgentForChatReply('telegram', 'chat-a', '999')).resolves.toBeNull();
  });

  it('a suppressed address resolves nothing and no other lookup runs', async () => {
    const db = buildSequencedDb([suppression, [agentOne]]);
    const repo = new AgentRepository(db as never);
    await expect(repo.resolveAgentForChatReply('telegram', 'chat-a', '999')).resolves.toBeNull();
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('does not resolve an agent from a non-active address row and reads only the exact active predicate', async () => {
    const { db, selectFields } = buildRecordingDb([noSuppression, [{ ...agentOne, isAddressActive: false }]]);
    const repo = new AgentRepository(db as never);
    await expect(repo.resolveAgentForChatReply('telegram', 'chat-a')).resolves.toBeNull();
    const activePredicate = renderWhere(selectFields[1]?.isAddressActive);
    expect(activePredicate.params).toEqual(['active']);
  });

  it('a non-active user-level row blocks the reply', async () => {
    const blockedUserLevel = { agentId: null, agentName: null, status: null, userId: null, isAddressActive: false };
    const db = buildSequencedDb([noSuppression, [], [blockedUserLevel]]);
    const repo = new AgentRepository(db as never);
    await expect(repo.resolveAgentForChatReply('telegram', 'chat-a', '999')).resolves.toBeNull();
  });

  it('an active user-level row never resolves an agent', async () => {
    const activeUserLevel = { agentId: null, agentName: null, status: null, userId: null, isAddressActive: true };
    const db = buildSequencedDb([noSuppression, [activeUserLevel]]);
    const repo = new AgentRepository(db as never);
    await expect(repo.resolveAgentForChatReply('telegram', 'chat-a')).resolves.toBeNull();
  });

  it('scopes the chat_addresses lookup to the agent owner via chat_addresses.userId = agents.userId', async () => {
    const { db, joinConditions } = buildRecordingDb([noSuppression, [activeAddressOne]]);
    const repo = new AgentRepository(db as never);
    await repo.resolveAgentForChatReply('telegram', 'chat-a');
    expect(renderWhere(joinConditions[0]).sql).toContain('"chat_addresses"."user_id" = "agents"."user_id"');
  });

  it('does not guess when an address is shared by several agent overrides and no message ID is given', async () => {
    const db = buildSequencedDb([noSuppression, [activeAddressOne, activeAddressTwo]]);
    const repo = new AgentRepository(db as never);
    await expect(repo.resolveAgentForChatReply('telegram', 'chat-a')).resolves.toBeNull();
  });

  it('trims the inbound address before matching', async () => {
    const { db, whereConditions } = buildRecordingDb([noSuppression, [activeAddressOne]]);
    const repo = new AgentRepository(db as never);
    await expect(repo.resolveAgentForChatReply('telegram', '  chat-a  ')).resolves.toEqual(agentOne);
    for (const condition of whereConditions) {
      const { params } = renderWhere(condition);
      expect(params).toContain('chat-a');
      expect(params).not.toContain('  chat-a  ');
    }
  });

  it('treats a blank inbound address as no address', async () => {
    const db = buildSequencedDb([]);
    const repo = new AgentRepository(db as never);
    await expect(repo.resolveAgentForChatReply('telegram', '   ', '999')).resolves.toBeNull();
    expect(db.select).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// isChatAddressSuppressed
// ---------------------------------------------------------------------------

describe('AgentRepository.isChatAddressSuppressed', () => {
  it('returns true when a suppression row exists for the address', async () => {
    const db = buildSequencedDb([[{ address: '123' }]]);
    const repo = new AgentRepository(db as never);
    await expect(repo.isChatAddressSuppressed('telegram', '123')).resolves.toBe(true);
  });

  it('returns false when no suppression row exists for the address', async () => {
    const db = buildSequencedDb([[]]);
    const repo = new AgentRepository(db as never);
    await expect(repo.isChatAddressSuppressed('whatsapp', '+15555550100')).resolves.toBe(false);
  });

  it('reads chat_suppressions on the normalised address and provider only', async () => {
    const { db, whereConditions } = buildRecordingDb([[]]);
    const repo = new AgentRepository(db as never);
    await repo.isChatAddressSuppressed('telegram', '  123  ');
    const { sql: whereSql, params } = renderWhere(whereConditions[0]);
    expect(whereSql).toContain('"chat_suppressions"."provider" = $1');
    expect(whereSql).toContain('"chat_suppressions"."address" = $2');
    expect(params).toEqual(['telegram', '123']);
    expect(whereSql).not.toContain('user_id');
    expect(whereSql).not.toContain('chat_addresses');
  });

  it('strips phone formatting for phone-based providers', async () => {
    const { db, whereConditions } = buildRecordingDb([[]]);
    const repo = new AgentRepository(db as never);
    await repo.isChatAddressSuppressed('sms', ' +1 (555) 555-0100 ');
    expect(renderWhere(whereConditions[0]).params).toEqual(['sms', '+15555550100']);
  });

  it('propagates a lookup error so the caller can fail closed', async () => {
    const db = { select: vi.fn(() => { throw new Error('db down'); }) };
    const repo = new AgentRepository(db as never);
    await expect(repo.isChatAddressSuppressed('telegram', '123')).rejects.toThrow('db down');
  });
});

// ---------------------------------------------------------------------------
// setChatAddress / revokeChatAddress / listChatAddressesForOutput
// ---------------------------------------------------------------------------

function buildWriteExecutor(deleted: Array<Record<string, unknown>> = []) {
  const returning = vi.fn().mockResolvedValue(deleted);
  const deleteWhere = vi.fn(() => Object.assign(Promise.resolve(undefined), { returning }));
  const deleteFn = vi.fn(() => ({ where: deleteWhere }));
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn(() => ({ onConflictDoUpdate }));
  const insertFn = vi.fn((_table: unknown) => ({ values }));
  return { executor: { insert: insertFn, delete: deleteFn }, deleteWhere, values, onConflictDoUpdate, insertFn };
}

describe('setChatAddress', () => {
  const scope = { userId: 'user-1', agentId: 'agent-1' };

  it('upserts an active row with the normalised address', async () => {
    const { executor, values, onConflictDoUpdate } = buildWriteExecutor();
    await setChatAddress(executor as never, scope, 'telegram', '  111111  ');
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      agentId: 'agent-1',
      provider: 'telegram',
      address: '111111',
      status: 'active',
    }));
    expect(onConflictDoUpdate).toHaveBeenCalledTimes(1);
  });

  it('writes the user-level scope with a null agent id', async () => {
    const { executor, values } = buildWriteExecutor();
    await setChatAddress(executor as never, { userId: 'user-1', agentId: null }, 'telegram', '111111');
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ agentId: null }));
  });

  it('never touches chat_suppressions when saving an address', async () => {
    const { executor, insertFn } = buildWriteExecutor();
    await setChatAddress(executor as never, scope, 'telegram', '222222');
    expect(insertFn).toHaveBeenCalledTimes(1);
    expect(getTableName(insertFn.mock.calls[0]?.[0] as never)).toBe('chat_addresses');
  });

  it.each([null, '', '   '])('deletes the active row and writes nothing for %j', async (blank) => {
    const { executor, deleteWhere, insertFn } = buildWriteExecutor();
    await setChatAddress(executor as never, scope, 'telegram', blank);
    expect(deleteWhere).toHaveBeenCalledTimes(1);
    const rendered = renderWhere((deleteWhere.mock.calls[0] as unknown[])[0]);
    expect(rendered.params).toEqual(['user-1', 'agent-1', 'telegram', 'active']);
    expect(insertFn).not.toHaveBeenCalled();
  });

  it('clears the user-level scope by agent_id is null', async () => {
    const { executor, deleteWhere } = buildWriteExecutor();
    await setChatAddress(executor as never, { userId: 'user-1', agentId: null }, 'telegram', null);
    expect(renderWhere((deleteWhere.mock.calls[0] as unknown[])[0]).sql).toContain('"chat_addresses"."agent_id" is null');
  });
});

describe('revokeChatAddress', () => {
  const scope = { userId: 'user-1', agentId: null };

  it('deletes the active row and writes the suppression row for that address', async () => {
    const { executor, values, insertFn } = buildWriteExecutor([{ address: ' 111111 ' }]);
    await expect(revokeChatAddress(executor as never, scope, 'telegram')).resolves.toBe(' 111111 ');
    expect(getTableName(insertFn.mock.calls[0]?.[0] as never)).toBe('chat_suppressions');
    expect(values).toHaveBeenCalledWith({ provider: 'telegram', address: '111111', status: 'revoked' });
  });

  it('writes nothing when the scope has no active row', async () => {
    const { executor, insertFn } = buildWriteExecutor([]);
    await expect(revokeChatAddress(executor as never, scope, 'telegram')).resolves.toBeNull();
    expect(insertFn).not.toHaveBeenCalled();
  });
});

describe('listChatAddressesForOutput', () => {
  it('returns user rows and per-agent rows for two agents from one query', async () => {
    const db = buildSequencedDb([[
      { agentId: null, provider: 'telegram', address: '222222', status: 'active' },
      { agentId: 'agent-1', provider: 'telegram', address: '111111', status: 'active' },
      { agentId: 'agent-2', provider: 'sms', address: '+15555550100', status: 'active' },
    ]]);
    const result = await listChatAddressesForOutput(db as never, 'user-1', ['agent-1', 'agent-2', 'agent-3']);
    expect(db.select).toHaveBeenCalledTimes(1);
    expect(result.user).toEqual([{ provider: 'telegram', address: '222222', scope: 'user', status: 'active' }]);
    expect(result.byAgent.get('agent-1')).toEqual([{ provider: 'telegram', address: '111111', scope: 'agent', status: 'active' }]);
    expect(result.byAgent.get('agent-2')).toEqual([{ provider: 'sms', address: '+15555550100', scope: 'agent', status: 'active' }]);
    expect(result.byAgent.has('agent-3')).toBe(false);
  });

  it('limits the query to the user and the listed agents', async () => {
    const { db, whereConditions } = buildRecordingDb([[]]);
    await listChatAddressesForOutput(db as never, 'user-1', ['agent-1', 'agent-2']);
    const rendered = renderWhere(whereConditions[0]);
    expect(rendered.sql).toContain('"chat_addresses"."user_id" = $1');
    expect(rendered.params).toEqual(['user-1', 'agent-1', 'agent-2']);
  });

  it('reads only user-level rows when no agent ids are given', async () => {
    const { db, whereConditions } = buildRecordingDb([[]]);
    await listChatAddressesForOutput(db as never, 'user-1', []);
    const rendered = renderWhere(whereConditions[0]);
    expect(rendered.sql).toContain('"chat_addresses"."agent_id" is null');
    expect(rendered.params).toEqual(['user-1']);
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
