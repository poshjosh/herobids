import { describe, it, expect, vi } from 'vitest';
import type { ToolContext } from '@herobids/domain';
import { AGENT_MESSAGE_TYPES } from '@herobids/domain';
import { skillTools } from './skills.js';

const listSkills = skillTools.find((t) => t.name === 'list_skills')!;
const addSkills = skillTools.find((t) => t.name === 'add_skills')!;
const removeSkills = skillTools.find((t) => t.name === 'remove_skills')!;

// ── Test helpers ────────────────────────────────────────────────────────────

function makeRedisMock(overrides: Partial<ToolContext['redis']> = {}): ToolContext['redis'] {
  return {
    hset: vi.fn(async () => 1),
    hget: vi.fn(async () => null),
    hgetall: vi.fn(async () => null),
    hdel: vi.fn(async () => 0),
    publish: vi.fn(async () => 0),
    blpop: vi.fn(async () => null),
    smembers: vi.fn(async () => []),
    sadd: vi.fn(async () => 0),
    srem: vi.fn(async () => 0),
    expire: vi.fn(async () => 0),
    ...overrides,
  };
}

/** Convenience: returns a redis mock whose blpop resolves with a serialized broker reply. */
function makeRedisWithReply(reply: Record<string, unknown>) {
  return makeRedisMock({
    blpop: vi.fn(async () => ['key', JSON.stringify(reply)]),
  });
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    agentId: 'agent-1',
    sessionId: 'session-1',
    phase: 'scout',
    executionMode: 'paper',
    redis: makeRedisMock(),
    publishToInbound: vi.fn(async () => undefined),
    ...overrides,
  };
}

function makeBrokerReply(overrides: Record<string, unknown> = {}) {
  return {
    status: 'ok',
    action: 'add',
    skillIds: ['skill-1'],
    warnings: [],
    ...overrides,
  };
}

// ── Tool exports sanity ─────────────────────────────────────────────────────

describe('skillTools exports', () => {
  it('exports exactly three tools', () => {
    expect(skillTools).toHaveLength(3);
  });

  it('exports tools with expected names', () => {
    const names = skillTools.map((t) => t.name);
    expect(names).toEqual(['list_skills', 'add_skills', 'remove_skills']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// list_skills
// ═══════════════════════════════════════════════════════════════════════════

describe('list_skills', () => {
  it('is registered with read-database category', () => {
    expect(listSkills.category).toBe('read-database');
  });

  it('returns assigned and available arrays when skillOps is present', async () => {
    const assigned = [{ id: 's1', name: 'Trading', description: 'Trade stuff' }];
    const available = [{ id: 's2', name: 'Monitoring', description: 'Watch stuff' }];
    const ctx = makeCtx({
      skillOps: {
        listAssigned: vi.fn(async () => assigned),
        listAvailable: vi.fn(async () => available),
      },
    });

    const result = await listSkills.execute({}, ctx);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ assigned, available });
  });

  it('returns error when skillOps is not wired', async () => {
    const ctx = makeCtx({ skillOps: undefined });

    const result = await listSkills.execute({}, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('skill.ops_unavailable');
  });

  it('returns error when listAssigned throws', async () => {
    const ctx = makeCtx({
      skillOps: {
        listAssigned: vi.fn(async () => { throw new Error('Redis down'); }),
        listAvailable: vi.fn(async () => []),
      },
    });

    const result = await listSkills.execute({}, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('skill.list_failed');
    expect(result.error).toContain('Redis down');
  });

  it('returns error when listAvailable throws', async () => {
    const ctx = makeCtx({
      skillOps: {
        listAssigned: vi.fn(async () => []),
        listAvailable: vi.fn(async () => { throw new Error('DB timeout'); }),
      },
    });

    const result = await listSkills.execute({}, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('skill.list_failed');
    expect(result.error).toContain('DB timeout');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Shared validation (add_skills & remove_skills)
// ═══════════════════════════════════════════════════════════════════════════

describe('skill mutation validation', () => {
  it.each([
    ['add_skills', addSkills],
    ['remove_skills', removeSkills],
  ] as const)('%s rejects empty skillIds array', async (_name, tool) => {
    const ctx = makeCtx();
    const result = await tool.execute({ skillIds: [] }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('validation.invalid_params');
  });

  it.each([
    ['add_skills', addSkills],
    ['remove_skills', removeSkills],
  ] as const)('%s rejects more than 10 skillIds', async (_name, tool) => {
    const ctx = makeCtx();
    const ids = Array.from({ length: 11 }, (_, i) => `skill-${i}`);
    const result = await tool.execute({ skillIds: ids }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('validation.invalid_params');
  });

  it.each([
    ['add_skills', addSkills],
    ['remove_skills', removeSkills],
  ] as const)('%s rejects non-string entries in skillIds', async (_name, tool) => {
    const ctx = makeCtx();
    const result = await tool.execute({ skillIds: [123, null] }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('validation.invalid_params');
  });

  it.each([
    ['add_skills', addSkills],
    ['remove_skills', removeSkills],
  ] as const)('%s rejects empty string in skillIds', async (_name, tool) => {
    const ctx = makeCtx();
    const result = await tool.execute({ skillIds: [''] }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('validation.invalid_params');
  });

  it.each([
    ['add_skills', addSkills],
    ['remove_skills', removeSkills],
  ] as const)('%s rejects missing skillIds entirely', async (_name, tool) => {
    const ctx = makeCtx();
    const result = await tool.execute({}, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('validation.invalid_params');
  });

  it.each([
    ['add_skills', addSkills],
    ['remove_skills', removeSkills],
  ] as const)('%s accepts exactly 10 skillIds', async (_name, tool) => {
    const ids = Array.from({ length: 10 }, (_, i) => `skill-${i}`);
    const reply = makeBrokerReply({ action: tool === addSkills ? 'add' : 'remove', skillIds: ids });
    const ctx = makeCtx({ redis: makeRedisWithReply(reply) });

    const result = await tool.execute({ skillIds: ids }, ctx);

    expect(result.success).toBe(true);
  });

  it.each([
    ['add_skills', addSkills],
    ['remove_skills', removeSkills],
  ] as const)('%s returns broker_unavailable when publishToInbound is missing', async (_name, tool) => {
    const ctx = makeCtx({ publishToInbound: undefined as unknown as ToolContext['publishToInbound'] });
    const result = await tool.execute({ skillIds: ['skill-1'] }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('skill.broker_unavailable');
  });

  it.each([
    ['add_skills', addSkills],
    ['remove_skills', removeSkills],
  ] as const)('%s returns broker_unavailable when redis.blpop is missing', async (_name, tool) => {
    const ctx = makeCtx({
      redis: {
        hset: vi.fn(async () => 1),
        hget: vi.fn(async () => null),
        hgetall: vi.fn(async () => null),
        hdel: vi.fn(async () => 0),
        publish: vi.fn(async () => 0),
        // blpop intentionally missing — cannot use makeRedisMock here
      } as unknown as ToolContext['redis'],
    });
    const result = await tool.execute({ skillIds: ['skill-1'] }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('skill.broker_unavailable');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// add_skills
// ═══════════════════════════════════════════════════════════════════════════

describe('add_skills', () => {
  it('is registered with write-database category', () => {
    expect(addSkills.category).toBe('write-database');
  });

  it('publishes MANAGE_AGENT_SKILLS with action "add" and a requestMessageId', async () => {
    const publishToInbound = vi.fn(async () => undefined);
    const reply = makeBrokerReply({ action: 'add', skillIds: ['skill-1'] });
    const ctx = makeCtx({ publishToInbound, redis: makeRedisWithReply(reply) });

    await addSkills.execute({ skillIds: ['skill-1'] }, ctx);

    expect(publishToInbound).toHaveBeenCalledOnce();
    const [type, payload] = publishToInbound.mock.calls[0]! as [string, Record<string, unknown>];
    expect(type).toBe(AGENT_MESSAGE_TYPES.MANAGE_AGENT_SKILLS);
    expect(payload.action).toBe('add');
    expect(payload.skillIds).toEqual(['skill-1']);
    expect(payload.requestMessageId).toBeTypeOf('string');
    expect((payload.requestMessageId as string).length).toBeGreaterThan(0);
  });

  it('calls blpop with the correct reply key derived from requestMessageId', async () => {
    const blpop = vi.fn(async () => ['key', JSON.stringify(makeBrokerReply())]);
    const publishToInbound = vi.fn(async () => undefined);
    const ctx = makeCtx({ publishToInbound, redis: makeRedisMock({ blpop }) });

    await addSkills.execute({ skillIds: ['skill-1'] }, ctx);

    expect(blpop).toHaveBeenCalledOnce();
    const [key, timeout] = blpop.mock.calls[0]! as [string, number];
    // The key format: agent:skills:reply:{requestMessageId}
    expect(key).toMatch(/^agent:skills:reply:[0-9a-f-]+$/);
    expect(timeout).toBe(15);

    // Verify the requestMessageId in the blpop key matches the one published
    const publishedId = (publishToInbound.mock.calls[0]![1] as Record<string, unknown>).requestMessageId as string;
    expect(key).toBe(`agent:skills:reply:${publishedId}`);
  });

  it('calls onSkillsChanged after receiving success reply', async () => {
    const onSkillsChanged = vi.fn(async () => ['skill-1', 'skill-2']);
    const reply = makeBrokerReply({ action: 'add', skillIds: ['skill-1'] });
    const ctx = makeCtx({ onSkillsChanged, redis: makeRedisWithReply(reply) });

    const result = await addSkills.execute({ skillIds: ['skill-1'] }, ctx);

    expect(onSkillsChanged).toHaveBeenCalledOnce();
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.added).toEqual(['skill-1']);
    expect(data.activeSkills).toEqual(['skill-1', 'skill-2']);
  });

  it('does NOT call onSkillsChanged after receiving error reply', async () => {
    const onSkillsChanged = vi.fn(async () => []);
    const reply = makeBrokerReply({ status: 'error', error: 'Not allowed', errorCode: 'skill.plan_exceeded' });
    const ctx = makeCtx({ onSkillsChanged, redis: makeRedisWithReply(reply) });

    const result = await addSkills.execute({ skillIds: ['skill-1'] }, ctx);

    expect(onSkillsChanged).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toBe('Not allowed');
    expect(result.errorCode).toBe('skill.plan_exceeded');
  });

  it('uses fallback error and errorCode when broker error reply omits them', async () => {
    const reply = makeBrokerReply({ status: 'error', error: undefined, errorCode: undefined });
    const ctx = makeCtx({ redis: makeRedisWithReply(reply) });

    const result = await addSkills.execute({ skillIds: ['skill-1'] }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Skill mutation failed');
    expect(result.errorCode).toBe('skill.mutation_failed');
  });

  it('returns updated skill list from onSkillsChanged result', async () => {
    const onSkillsChanged = vi.fn(async () => ['skill-a', 'skill-b', 'skill-c']);
    const reply = makeBrokerReply({ action: 'add', skillIds: ['skill-c'] });
    const ctx = makeCtx({ onSkillsChanged, redis: makeRedisWithReply(reply) });

    const result = await addSkills.execute({ skillIds: ['skill-c'] }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.activeSkills).toEqual(['skill-a', 'skill-b', 'skill-c']);
    expect(data.added).toEqual(['skill-c']);
  });

  it('includes warnings from broker reply when present', async () => {
    const onSkillsChanged = vi.fn(async () => ['skill-1']);
    const reply = makeBrokerReply({
      action: 'add',
      skillIds: ['skill-1'],
      warnings: ['Skill requires premium plan'],
    });
    const ctx = makeCtx({ onSkillsChanged, redis: makeRedisWithReply(reply) });

    const result = await addSkills.execute({ skillIds: ['skill-1'] }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.warnings).toEqual(['Skill requires premium plan']);
  });

  it('omits warnings key when broker reply has no warnings', async () => {
    const onSkillsChanged = vi.fn(async () => ['skill-1']);
    const reply = makeBrokerReply({ action: 'add', skillIds: ['skill-1'], warnings: [] });
    const ctx = makeCtx({ onSkillsChanged, redis: makeRedisWithReply(reply) });

    const result = await addSkills.execute({ skillIds: ['skill-1'] }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.warnings).toBeUndefined();
  });

  it('gracefully handles missing onSkillsChanged (fallback to "next tick" note)', async () => {
    const reply = makeBrokerReply({ action: 'add', skillIds: ['skill-1'] });
    const ctx = makeCtx({ onSkillsChanged: undefined, redis: makeRedisWithReply(reply) });

    const result = await addSkills.execute({ skillIds: ['skill-1'] }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.added).toEqual(['skill-1']);
    expect(data.note).toEqual(expect.stringContaining('next tick'));
    expect(data.activeSkills).toBeUndefined();
  });

  it('returns fallback note when onSkillsChanged throws', async () => {
    const onSkillsChanged = vi.fn(async () => { throw new Error('reload failed'); });
    const reply = makeBrokerReply({ action: 'add', skillIds: ['skill-1'] });
    const ctx = makeCtx({ onSkillsChanged, redis: makeRedisWithReply(reply) });

    const result = await addSkills.execute({ skillIds: ['skill-1'] }, ctx);

    // Still success — DB write succeeded, only hot-reload failed
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.added).toEqual(['skill-1']);
    expect(data.note).toEqual(expect.stringContaining('next tick'));
    expect(data.activeSkills).toBeUndefined();
  });

  it('preserves warnings when onSkillsChanged throws', async () => {
    const onSkillsChanged = vi.fn(async () => { throw new Error('reload failed'); });
    const reply = makeBrokerReply({
      action: 'add',
      skillIds: ['skill-1'],
      warnings: ['Approaching plan limit'],
    });
    const ctx = makeCtx({ onSkillsChanged, redis: makeRedisWithReply(reply) });

    const result = await addSkills.execute({ skillIds: ['skill-1'] }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.note).toEqual(expect.stringContaining('next tick'));
    expect(data.warnings).toEqual(['Approaching plan limit']);
  });

  it('handles BLPOP timeout (returns retryable error)', async () => {
    // Default makeRedisMock has blpop returning null (timeout)
    const ctx = makeCtx();

    const result = await addSkills.execute({ skillIds: ['skill-1'] }, ctx);

    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.errorCode).toBe('broker.timeout');
  });

  it('returns broker.communication_error on publishToInbound exception', async () => {
    const ctx = makeCtx({
      publishToInbound: vi.fn(async () => { throw new Error('Redis NOPERM'); }),
    });

    const result = await addSkills.execute({ skillIds: ['skill-1'] }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('broker.communication_error');
    expect(result.error).toContain('Redis NOPERM');
  });

  it('returns broker.communication_error when BLPOP returns unparseable JSON', async () => {
    const ctx = makeCtx({
      redis: makeRedisMock({ blpop: vi.fn(async () => ['key', 'not-valid-json{']) }),
    });

    const result = await addSkills.execute({ skillIds: ['skill-1'] }, ctx);

    expect(result.success).toBe(false);
    // JSON.parse throws before schema validation → caught by outer catch
    expect(result.errorCode).toBe('broker.communication_error');
  });

  it('returns broker.malformed_reply on valid JSON that fails schema validation', async () => {
    const badReply = JSON.stringify({ status: 'ok' }); // missing 'action' field
    const ctx = makeCtx({
      redis: makeRedisMock({ blpop: vi.fn(async () => ['key', badReply]) }),
    });

    const result = await addSkills.execute({ skillIds: ['skill-1'] }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('broker.malformed_reply');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// remove_skills — mirrors add_skills with action 'remove'
// ═══════════════════════════════════════════════════════════════════════════

describe('remove_skills', () => {
  it('is registered with write-database category', () => {
    expect(removeSkills.category).toBe('write-database');
  });

  it('publishes MANAGE_AGENT_SKILLS with action "remove" and a requestMessageId', async () => {
    const publishToInbound = vi.fn(async () => undefined);
    const reply = makeBrokerReply({ action: 'remove', skillIds: ['skill-1'] });
    const ctx = makeCtx({ publishToInbound, redis: makeRedisWithReply(reply) });

    await removeSkills.execute({ skillIds: ['skill-1'] }, ctx);

    expect(publishToInbound).toHaveBeenCalledOnce();
    const [type, payload] = publishToInbound.mock.calls[0]! as [string, Record<string, unknown>];
    expect(type).toBe(AGENT_MESSAGE_TYPES.MANAGE_AGENT_SKILLS);
    expect(payload.action).toBe('remove');
    expect(payload.skillIds).toEqual(['skill-1']);
    expect(payload.requestMessageId).toBeTypeOf('string');
  });

  it('calls onSkillsChanged after receiving success reply', async () => {
    const onSkillsChanged = vi.fn(async () => ['skill-2']);
    const reply = makeBrokerReply({ action: 'remove', skillIds: ['skill-1'] });
    const ctx = makeCtx({ onSkillsChanged, redis: makeRedisWithReply(reply) });

    const result = await removeSkills.execute({ skillIds: ['skill-1'] }, ctx);

    expect(onSkillsChanged).toHaveBeenCalledOnce();
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.removed).toEqual(['skill-1']);
    expect(data.activeSkills).toEqual(['skill-2']);
  });

  it('does NOT call onSkillsChanged after receiving error reply', async () => {
    const onSkillsChanged = vi.fn(async () => []);
    const reply = makeBrokerReply({ status: 'error', action: 'remove', error: 'Base skill cannot be removed' });
    const ctx = makeCtx({ onSkillsChanged, redis: makeRedisWithReply(reply) });

    const result = await removeSkills.execute({ skillIds: ['skill-1'] }, ctx);

    expect(onSkillsChanged).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toBe('Base skill cannot be removed');
  });

  it('uses "removed" key (not "added") in response data', async () => {
    const reply = makeBrokerReply({ action: 'remove', skillIds: ['skill-1', 'skill-2'] });
    const ctx = makeCtx({
      onSkillsChanged: vi.fn(async () => []),
      redis: makeRedisWithReply(reply),
    });

    const result = await removeSkills.execute({ skillIds: ['skill-1', 'skill-2'] }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.removed).toEqual(['skill-1', 'skill-2']);
    expect(data.added).toBeUndefined();
  });

  it('gracefully handles missing onSkillsChanged (fallback to "next tick" note)', async () => {
    const reply = makeBrokerReply({ action: 'remove', skillIds: ['skill-1'] });
    const ctx = makeCtx({ onSkillsChanged: undefined, redis: makeRedisWithReply(reply) });

    const result = await removeSkills.execute({ skillIds: ['skill-1'] }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.removed).toEqual(['skill-1']);
    expect(data.note).toEqual(expect.stringContaining('next tick'));
  });

  it('handles BLPOP timeout (returns retryable error)', async () => {
    // Default makeRedisMock has blpop returning null (timeout)
    const ctx = makeCtx();

    const result = await removeSkills.execute({ skillIds: ['skill-1'] }, ctx);

    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.errorCode).toBe('broker.timeout');
  });

  it('returns broker.communication_error on publishToInbound exception', async () => {
    const ctx = makeCtx({
      publishToInbound: vi.fn(async () => { throw new Error('Connection refused'); }),
    });

    const result = await removeSkills.execute({ skillIds: ['skill-1'] }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('broker.communication_error');
    expect(result.error).toContain('Connection refused');
  });

  it('returns broker.malformed_reply on valid JSON that fails schema validation', async () => {
    const badReply = JSON.stringify({ status: 'ok' }); // missing 'action'
    const ctx = makeCtx({
      redis: makeRedisMock({ blpop: vi.fn(async () => ['key', badReply]) }),
    });

    const result = await removeSkills.execute({ skillIds: ['skill-1'] }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('broker.malformed_reply');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// runtime-tool-visibility integration
// ═══════════════════════════════════════════════════════════════════════════

describe('DATABASE_DEPENDENT_TOOLS includes skill tools', () => {
  // These are integration assertions verifying that runtime-tool-visibility
  // will properly degrade skill tools when database goes offline.
  // The actual degradation behavior is tested in runtime-tool-visibility.test.ts.

  it.each(['list_skills', 'add_skills', 'remove_skills'])(
    '%s is in DATABASE_DEPENDENT_TOOLS',
    async (toolName) => {
      // Dynamic import to avoid coupling test file ordering
      const { DATABASE_DEPENDENT_TOOLS } = await import('../runtime-tool-visibility.js');
      expect(DATABASE_DEPENDENT_TOOLS.has(toolName)).toBe(true);
    },
  );
});
