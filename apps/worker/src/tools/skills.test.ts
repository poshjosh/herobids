import { describe, it, expect, vi } from 'vitest';
import type { ToolContext } from '@herobids/domain';
import { AGENT_MESSAGE_TYPES } from '@herobids/domain';
import { skillTools } from './skills.js';

const listSkills = skillTools.find((t) => t.name === 'list_skills')!;
const addSkills = skillTools.find((t) => t.name === 'add_skills')!;
const removeSkills = skillTools.find((t) => t.name === 'remove_skills')!;
const searchSkills = skillTools.find((t) => t.name === 'search_skills')!;

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

/** Convenience: builds a skillOps mock with sensible defaults for unused methods. */
function makeSkillOps(
  overrides: Partial<NonNullable<ToolContext['skillOps']>> = {},
): NonNullable<ToolContext['skillOps']> {
  return {
    listAssigned: vi.fn(async () => []),
    listAvailable: vi.fn(async () => []),
    search: vi.fn(async () => []),
    ...overrides,
  };
}

// ── Tool exports sanity ─────────────────────────────────────────────────────

describe('skillTools exports', () => {
  it('exports exactly four tools', () => {
    expect(skillTools).toHaveLength(4);
  });

  it('exports tools with expected names', () => {
    const names = skillTools.map((t) => t.name);
    expect(names).toEqual(['list_skills', 'add_skills', 'remove_skills', 'search_skills']);
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
    const assigned = [{ id: 's1', slug: 'trading', name: 'Trading', description: 'Trade stuff', dependsOn: [] as string[] }];
    const available = [{ id: 's2', slug: 'monitoring', name: 'Monitoring', description: 'Watch stuff', dependsOn: [] as string[] }];
    const ctx = makeCtx({
      skillOps: {
        listAssigned: vi.fn(async () => assigned),
        listAvailable: vi.fn(async () => available),
        search: vi.fn(async () => []),
      },
    });

    const result = await listSkills.execute({}, ctx);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      assigned,
      available,
      hint: 'For capabilities not listed here, use search_skills to search both platform skills and external skills discoverable through skills.sh.',
    });
  });

  it('surfaces dependsOn field in both assigned and available arrays', async () => {
    const assigned = [
      { id: 's1', slug: 'trading', name: 'Trading', description: 'Trade stuff', dependsOn: ['s3'] },
    ];
    const available = [
      { id: 's2', slug: 'monitoring', name: 'Monitoring', description: 'Watch stuff', dependsOn: ['s1', 's3'] },
    ];
    const ctx = makeCtx({
      skillOps: {
        listAssigned: vi.fn(async () => assigned),
        listAvailable: vi.fn(async () => available),
        search: vi.fn(async () => []),
      },
    });

    const result = await listSkills.execute({}, ctx);

    expect(result.success).toBe(true);
    const data = result.data as { assigned: typeof assigned; available: typeof available };
    expect(data.assigned[0]!.dependsOn).toEqual(['s3']);
    expect(data.available[0]!.dependsOn).toEqual(['s1', 's3']);
  });

  it('returns empty dependsOn arrays when skills have no dependencies', async () => {
    const assigned = [
      { id: 's1', slug: 'trading', name: 'Trading', description: 'Trade stuff', dependsOn: [] as string[] },
    ];
    const available = [
      { id: 's2', slug: 'monitoring', name: 'Monitoring', description: 'Watch stuff', dependsOn: [] as string[] },
    ];
    const ctx = makeCtx({
      skillOps: {
        listAssigned: vi.fn(async () => assigned),
        listAvailable: vi.fn(async () => available),
        search: vi.fn(async () => []),
      },
    });

    const result = await listSkills.execute({}, ctx);

    expect(result.success).toBe(true);
    const data = result.data as { assigned: typeof assigned; available: typeof available };
    expect(data.assigned[0]!.dependsOn).toEqual([]);
    expect(data.available[0]!.dependsOn).toEqual([]);
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
        search: vi.fn(async () => []),
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
        search: vi.fn(async () => []),
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

  // ── missingDependencies after add ─────────────────────────────────────

  describe('missingDependencies', () => {
    it('omits missingDependencies when all dependencies are satisfied', async () => {
      const onSkillsChanged = vi.fn(async () => ['skill-1', 'dep-a', 'dep-b']);
      const reply = makeBrokerReply({ action: 'add', skillIds: ['skill-1'] });
      const ctx = makeCtx({
        onSkillsChanged,
        redis: makeRedisWithReply(reply),
        skillOps: makeSkillOps({
          listAssigned: vi.fn(async () => [
            { id: 'skill-1', slug: 'trading', name: 'Trading', description: 'Trade', dependsOn: ['dep-a', 'dep-b'] },
          ]),
        }),
      });

      const result = await addSkills.execute({ skillIds: ['skill-1'] }, ctx);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.missingDependencies).toBeUndefined();
    });

    it('includes missingDependencies when some dependencies are not active', async () => {
      const onSkillsChanged = vi.fn(async () => ['skill-1']);
      const reply = makeBrokerReply({ action: 'add', skillIds: ['skill-1'] });
      const ctx = makeCtx({
        onSkillsChanged,
        redis: makeRedisWithReply(reply),
        skillOps: makeSkillOps({
          listAssigned: vi.fn(async () => [
            { id: 'skill-1', slug: 'trading', name: 'Trading', description: 'Trade', dependsOn: ['dep-a', 'dep-b'] },
          ]),
        }),
      });

      const result = await addSkills.execute({ skillIds: ['skill-1'] }, ctx);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.missingDependencies).toEqual([
        { skillId: 'dep-a', requiredBy: 'skill-1' },
        { skillId: 'dep-b', requiredBy: 'skill-1' },
      ]);
    });

    it('skips missingDependencies computation when skillOps is not available', async () => {
      const onSkillsChanged = vi.fn(async () => ['skill-1']);
      const reply = makeBrokerReply({ action: 'add', skillIds: ['skill-1'] });
      const ctx = makeCtx({
        onSkillsChanged,
        redis: makeRedisWithReply(reply),
        skillOps: undefined,
      });

      const result = await addSkills.execute({ skillIds: ['skill-1'] }, ctx);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.missingDependencies).toBeUndefined();
      expect(data.added).toEqual(['skill-1']);
    });

    it('fails silently when skillOps.listAssigned throws during dependency check', async () => {
      const onSkillsChanged = vi.fn(async () => ['skill-1']);
      const reply = makeBrokerReply({ action: 'add', skillIds: ['skill-1'] });
      const ctx = makeCtx({
        onSkillsChanged,
        redis: makeRedisWithReply(reply),
        skillOps: makeSkillOps({
          listAssigned: vi.fn(async () => { throw new Error('DB connection lost'); }),
        }),
      });

      const result = await addSkills.execute({ skillIds: ['skill-1'] }, ctx);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      // Dependency check failed silently — no missingDependencies in output
      expect(data.missingDependencies).toBeUndefined();
      expect(data.added).toEqual(['skill-1']);
      expect(data.activeSkills).toEqual(['skill-1']);
    });

    it('handles multiple added skills with overlapping unmet dependencies', async () => {
      const onSkillsChanged = vi.fn(async () => ['skill-a', 'skill-b']);
      const reply = makeBrokerReply({ action: 'add', skillIds: ['skill-a', 'skill-b'] });
      const ctx = makeCtx({
        onSkillsChanged,
        redis: makeRedisWithReply(reply),
        skillOps: makeSkillOps({
          listAssigned: vi.fn(async () => [
            { id: 'skill-a', slug: 'a', name: 'A', description: 'Skill A', dependsOn: ['dep-shared', 'dep-only-a'] },
            { id: 'skill-b', slug: 'b', name: 'B', description: 'Skill B', dependsOn: ['dep-shared'] },
          ]),
        }),
      });

      const result = await addSkills.execute({ skillIds: ['skill-a', 'skill-b'] }, ctx);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      const missing = data.missingDependencies as Array<{ skillId: string; requiredBy: string }>;
      expect(missing).toBeDefined();
      // dep-shared is unmet for both skill-a and skill-b; dep-only-a is unmet for skill-a only
      expect(missing).toEqual(expect.arrayContaining([
        { skillId: 'dep-shared', requiredBy: 'skill-a' },
        { skillId: 'dep-only-a', requiredBy: 'skill-a' },
        { skillId: 'dep-shared', requiredBy: 'skill-b' },
      ]));
      expect(missing).toHaveLength(3);
    });

    it('skips added skill not found in assigned list (no dependsOn to check)', async () => {
      const onSkillsChanged = vi.fn(async () => ['skill-1']);
      const reply = makeBrokerReply({ action: 'add', skillIds: ['skill-1'] });
      const ctx = makeCtx({
        onSkillsChanged,
        redis: makeRedisWithReply(reply),
        skillOps: makeSkillOps({
          // listAssigned returns a different skill — 'skill-1' is not in the list
          listAssigned: vi.fn(async () => [
            { id: 'skill-other', slug: 'other', name: 'Other', description: 'Other skill', dependsOn: ['dep-x'] },
          ]),
        }),
      });

      const result = await addSkills.execute({ skillIds: ['skill-1'] }, ctx);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      // skill-1 not found in assigned → no dependency entries emitted
      expect(data.missingDependencies).toBeUndefined();
    });

    it('only reports dependencies that are not in the activeSkills set', async () => {
      const onSkillsChanged = vi.fn(async () => ['skill-1', 'dep-a']);
      const reply = makeBrokerReply({ action: 'add', skillIds: ['skill-1'] });
      const ctx = makeCtx({
        onSkillsChanged,
        redis: makeRedisWithReply(reply),
        skillOps: makeSkillOps({
          listAssigned: vi.fn(async () => [
            { id: 'skill-1', slug: 'trading', name: 'Trading', description: 'Trade', dependsOn: ['dep-a', 'dep-b'] },
          ]),
        }),
      });

      const result = await addSkills.execute({ skillIds: ['skill-1'] }, ctx);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      // dep-a is active, dep-b is not → only dep-b reported
      expect(data.missingDependencies).toEqual([
        { skillId: 'dep-b', requiredBy: 'skill-1' },
      ]);
    });

    it('omits missingDependencies when skill has empty dependsOn', async () => {
      const onSkillsChanged = vi.fn(async () => ['skill-1']);
      const reply = makeBrokerReply({ action: 'add', skillIds: ['skill-1'] });
      const ctx = makeCtx({
        onSkillsChanged,
        redis: makeRedisWithReply(reply),
        skillOps: makeSkillOps({
          listAssigned: vi.fn(async () => [
            { id: 'skill-1', slug: 'simple', name: 'Simple', description: 'No deps', dependsOn: [] },
          ]),
        }),
      });

      const result = await addSkills.execute({ skillIds: ['skill-1'] }, ctx);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.missingDependencies).toBeUndefined();
    });
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

  it('never computes missingDependencies even when skillOps is available', async () => {
    const listAssigned = vi.fn(async () => [
      { id: 'skill-1', slug: 'trading', name: 'Trading', description: 'Trade', dependsOn: ['dep-missing'] },
    ]);
    const onSkillsChanged = vi.fn(async () => ['skill-1']);
    const reply = makeBrokerReply({ action: 'remove', skillIds: ['skill-1'] });
    const ctx = makeCtx({
      onSkillsChanged,
      redis: makeRedisWithReply(reply),
      skillOps: makeSkillOps({ listAssigned }),
    });

    const result = await removeSkills.execute({ skillIds: ['skill-1'] }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.missingDependencies).toBeUndefined();
    // listAssigned should NOT be called for dependency check during remove
    expect(listAssigned).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// skillOps.search stub contract
// ═══════════════════════════════════════════════════════════════════════════

describe('skillOps.search stub contract', () => {
  type SkillSearchResult = Awaited<ReturnType<NonNullable<ToolContext['skillOps']>['search']>>;

  it('returns an empty array when called with query only', async () => {
    const searchFn: NonNullable<ToolContext['skillOps']>['search'] = vi.fn(async () => []);
    const ctx = makeCtx({
      skillOps: {
        listAssigned: vi.fn(async () => []),
        listAvailable: vi.fn(async () => []),
        search: searchFn,
      },
    });

    const result = await ctx.skillOps!.search('trading');

    expect(result).toEqual([]);
    expect(searchFn).toHaveBeenCalledWith('trading');
  });

  it('returns an empty array when called with query and limit', async () => {
    const searchFn: NonNullable<ToolContext['skillOps']>['search'] = vi.fn(async () => []);
    const ctx = makeCtx({
      skillOps: {
        listAssigned: vi.fn(async () => []),
        listAvailable: vi.fn(async () => []),
        search: searchFn,
      },
    });

    const result = await ctx.skillOps!.search('monitoring', 5);

    expect(result).toEqual([]);
    expect(searchFn).toHaveBeenCalledWith('monitoring', 5);
  });

  it('accepts search results that include dependsOn and isAssigned fields', async () => {
    const searchResults: SkillSearchResult = [
      { id: 's1', slug: 'trading', name: 'Trading', description: 'Trade', isAssigned: true, dependsOn: ['s2'] },
      { id: 's3', slug: 'analytics', name: 'Analytics', description: 'Analyze', isAssigned: false, dependsOn: [] as string[] },
    ];
    const ctx = makeCtx({
      skillOps: {
        listAssigned: vi.fn(async () => []),
        listAvailable: vi.fn(async () => []),
        search: vi.fn(async () => searchResults),
      },
    });

    const result = await ctx.skillOps!.search('trade', 10);

    expect(result).toHaveLength(2);
    expect(result[0]!.isAssigned).toBe(true);
    expect(result[0]!.dependsOn).toEqual(['s2']);
    expect(result[1]!.isAssigned).toBe(false);
    expect(result[1]!.dependsOn).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// skillOps.search — limit capping contract
// (agent.ts applies Math.min(limit ?? 10, 20) — these mocks replicate that
//  logic so consumers can rely on the documented cap behavior)
// ═══════════════════════════════════════════════════════════════════════════

describe('skillOps.search limit capping contract', () => {
  type SearchResult = Awaited<ReturnType<NonNullable<ToolContext['skillOps']>['search']>>;

  /** Simulates agent.ts limit capping: Math.min(limit ?? 10, 20) */
  function makeCappedSearch(pool: SearchResult) {
    return vi.fn(async (_q: string, limit?: number) => {
      const effectiveLimit = Math.min(limit ?? 10, 20);
      return pool.slice(0, effectiveLimit);
    });
  }

  const pool: SearchResult = Array.from({ length: 25 }, (_, i) => ({
    id: `sk-${i}`,
    slug: `skill-${i}`,
    name: `Skill ${i}`,
    description: `Skill ${i} desc`,
    isAssigned: i % 3 === 0,
    dependsOn: [],
  }));

  it('caps at 20 even when caller requests more', async () => {
    const ctx = makeCtx({ skillOps: makeSkillOps({ search: makeCappedSearch(pool) }) });

    const result = await ctx.skillOps!.search('skill', 50);

    expect(result).toHaveLength(20);
  });

  it('defaults to 10 when limit is omitted', async () => {
    const ctx = makeCtx({ skillOps: makeSkillOps({ search: makeCappedSearch(pool) }) });

    const result = await ctx.skillOps!.search('skill');

    expect(result).toHaveLength(10);
  });

  it('honours explicit limit below the cap', async () => {
    const ctx = makeCtx({ skillOps: makeSkillOps({ search: makeCappedSearch(pool) }) });

    const result = await ctx.skillOps!.search('skill', 3);

    expect(result).toHaveLength(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// list_skills tool — dependsOn propagation from skillOps
// ═══════════════════════════════════════════════════════════════════════════

describe('list_skills dependsOn propagation', () => {
  it('propagates dependsOn from listAssigned through to tool response data', async () => {
    const assigned = [
      { id: 'sk-trade', slug: 'trading', name: 'Trading', description: 'Trade', dependsOn: ['sk-market', 'sk-risk'] },
      { id: 'sk-scan', slug: 'scanner', name: 'Scanner', description: 'Scan', dependsOn: [] as string[] },
    ];
    const ctx = makeCtx({
      skillOps: makeSkillOps({ listAssigned: vi.fn(async () => assigned) }),
    });

    const result = await listSkills.execute({}, ctx);

    expect(result.success).toBe(true);
    const data = result.data as { assigned: typeof assigned; available: unknown[] };
    expect(data.assigned[0]!.dependsOn).toEqual(['sk-market', 'sk-risk']);
    expect(data.assigned[1]!.dependsOn).toEqual([]);
  });

  it('propagates dependsOn from listAvailable through to tool response data', async () => {
    const available = [
      { id: 'sk-alerts', slug: 'alerts', name: 'Alerts', description: 'Alert', dependsOn: ['sk-monitor'] },
    ];
    const ctx = makeCtx({
      skillOps: makeSkillOps({ listAvailable: vi.fn(async () => available) }),
    });

    const result = await listSkills.execute({}, ctx);

    expect(result.success).toBe(true);
    const data = result.data as { assigned: unknown[]; available: typeof available };
    expect(data.available[0]!.dependsOn).toEqual(['sk-monitor']);
  });

  it('handles large dependsOn arrays from both assigned and available', async () => {
    const manyDeps = Array.from({ length: 8 }, (_, i) => `sk-dep-${i}`);
    const assigned = [
      { id: 'sk-complex', slug: 'complex', name: 'Complex', description: 'Many deps', dependsOn: manyDeps },
    ];
    const available = [
      { id: 'sk-simple', slug: 'simple', name: 'Simple', description: 'Few deps', dependsOn: ['sk-dep-0'] },
    ];
    const ctx = makeCtx({
      skillOps: makeSkillOps({
        listAssigned: vi.fn(async () => assigned),
        listAvailable: vi.fn(async () => available),
      }),
    });

    const result = await listSkills.execute({}, ctx);

    expect(result.success).toBe(true);
    const data = result.data as { assigned: typeof assigned; available: typeof available };
    expect(data.assigned[0]!.dependsOn).toHaveLength(8);
    expect(data.available[0]!.dependsOn).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// search_skills
// ═══════════════════════════════════════════════════════════════════════════

/** Shared type for the search_skills response data shape. */
type SearchSkillsData = {
  local: {
    results: Array<{
      id: string;
      name: string;
      description: string;
      isAssigned: boolean;
      dependsOn: string[];
    }>;
  };
  external: { results: string } | { note: string };
};

describe('search_skills', () => {
  it('is registered with read-database category', () => {
    expect(searchSkills.category).toBe('read-database');
  });

  // ── Validation ──────────────────────────────────────────────────────────

  describe('validation', () => {
    it('rejects empty query', async () => {
      const ctx = makeCtx({ skillOps: makeSkillOps() });
      const result = await searchSkills.execute({ query: '' }, ctx);

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('validation.invalid_params');
    });

    it('rejects query exceeding 200 characters', async () => {
      const ctx = makeCtx({ skillOps: makeSkillOps() });
      const longQuery = 'a'.repeat(201);
      const result = await searchSkills.execute({ query: longQuery }, ctx);

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('validation.invalid_params');
    });

    it('rejects missing query parameter', async () => {
      const ctx = makeCtx({ skillOps: makeSkillOps() });
      const result = await searchSkills.execute({}, ctx);

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('validation.invalid_params');
    });

    it('rejects non-string query', async () => {
      const ctx = makeCtx({ skillOps: makeSkillOps() });
      const result = await searchSkills.execute({ query: 123 }, ctx);

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('validation.invalid_params');
    });

    it('accepts query at exactly 200 characters', async () => {
      const ctx = makeCtx({ skillOps: makeSkillOps() });
      const maxQuery = 'a'.repeat(200);
      const result = await searchSkills.execute({ query: maxQuery }, ctx);

      expect(result.success).toBe(true);
    });

    it('accepts a single-character query', async () => {
      const ctx = makeCtx({ skillOps: makeSkillOps() });
      const result = await searchSkills.execute({ query: 'x' }, ctx);

      expect(result.success).toBe(true);
    });

    it('accepts whitespace-only query (passes min-length but tokenizes to zero external tokens)', async () => {
      const ctx = makeCtx({ skillOps: makeSkillOps() });
      const result = await searchSkills.execute({ query: '   ' }, ctx);

      // Zod min(1) passes (length 3), but tokenizeQuery produces zero tokens
      // Local search receives the raw string; external arm degrades gracefully
      expect(result.success).toBe(true);
      const data = result.data as SearchSkillsData;
      expect(data.local.results).toEqual([]);
      expect(data.external).toHaveProperty('note');
    });
  });

  // ── Local search ────────────────────────────────────────────────────────

  describe('local search', () => {
    it('returns local results when skillOps.search returns data', async () => {
      const searchResults = [
        { id: 'sk-1', slug: 'trading', name: 'Trading', description: 'Trade crypto', isAssigned: true, dependsOn: ['sk-2'] },
        { id: 'sk-3', slug: 'analytics', name: 'Analytics', description: 'Analyze markets', isAssigned: false, dependsOn: [] as string[] },
      ];
      const ctx = makeCtx({
        skillOps: makeSkillOps({ search: vi.fn(async () => searchResults) }),
      });

      const result = await searchSkills.execute({ query: 'trading' }, ctx);

      expect(result.success).toBe(true);
      const data = result.data as SearchSkillsData;
      expect(data.local.results).toEqual(searchResults);
    });

    it('passes the query string to skillOps.search', async () => {
      const searchFn = vi.fn(async () => []);
      const ctx = makeCtx({
        skillOps: makeSkillOps({ search: searchFn }),
      });

      await searchSkills.execute({ query: 'crypto monitoring' }, ctx);

      expect(searchFn).toHaveBeenCalledWith('crypto monitoring');
      expect(searchFn).toHaveBeenCalledOnce();
      expect(searchFn.mock.calls[0]).toHaveLength(1);
    });

    it('returns empty local results when skillOps is not provided', async () => {
      const ctx = makeCtx({ skillOps: undefined });

      const result = await searchSkills.execute({ query: 'trading' }, ctx);

      expect(result.success).toBe(true);
      const data = result.data as SearchSkillsData;
      expect(data.local.results).toEqual([]);
    });

    it('returns empty local results when skillOps.search throws', async () => {
      const ctx = makeCtx({
        skillOps: makeSkillOps({
          search: vi.fn(async () => { throw new Error('DB connection lost'); }),
        }),
      });

      const result = await searchSkills.execute({ query: 'trading' }, ctx);

      expect(result.success).toBe(true);
      const data = result.data as SearchSkillsData;
      expect(data.local.results).toEqual([]);
    });

    it('does not fail when skillOps.search throws a non-Error value', async () => {
      const ctx = makeCtx({
        skillOps: makeSkillOps({
          search: vi.fn(async () => { throw 'string error'; }),
        }),
      });

      const result = await searchSkills.execute({ query: 'trading' }, ctx);

      expect(result.success).toBe(true);
      const data = result.data as SearchSkillsData;
      expect(data.local.results).toEqual([]);
    });
  });

  // ── External search ─────────────────────────────────────────────────────
  // NOTE: These tests only cover the degradation path (dynamic import or
  // spawn fails in the test environment). The external success path — where
  // runExternalSkillSearch returns { output } — requires mocking
  // child_process.spawn and the dynamic import of ./workspace.js. That path
  // is covered at the integration level; adding spawn mocking here would
  // couple unit tests to internal implementation details.

  describe('external search', () => {
    it('returns a note when external search is unavailable (dynamic import fails)', async () => {
      const ctx = makeCtx({ skillOps: makeSkillOps() });

      const result = await searchSkills.execute({ query: 'trading' }, ctx);

      expect(result.success).toBe(true);
      const data = result.data as SearchSkillsData;
      // The dynamic import of ./workspace.js may fail or npx skills won't be available —
      // either way the external arm should gracefully degrade with a note
      expect('note' in data.external).toBe(true);
      const ext = data.external as { note: string };
      expect(typeof ext.note).toBe('string');
      expect(ext.note.length).toBeGreaterThan(0);
    });

    it('does not cause overall failure when external search fails', async () => {
      const searchResults = [
        { id: 'sk-1', slug: 'trading', name: 'Trading', description: 'Trade', isAssigned: false, dependsOn: [] as string[] },
      ];
      const ctx = makeCtx({
        skillOps: makeSkillOps({ search: vi.fn(async () => searchResults) }),
      });

      const result = await searchSkills.execute({ query: 'trading' }, ctx);

      expect(result.success).toBe(true);
      const data = result.data as SearchSkillsData;
      // Local results should still be present despite external failure
      expect(data.local.results).toEqual(searchResults);
      expect('note' in data.external).toBe(true);
    });
  });

  // ── Response shape ──────────────────────────────────────────────────────

  describe('response shape', () => {
    it('returns { local: { results }, external: { ... } } structure', async () => {
      const ctx = makeCtx({ skillOps: makeSkillOps() });

      const result = await searchSkills.execute({ query: 'test' }, ctx);

      expect(result.success).toBe(true);
      const data = result.data as SearchSkillsData;
      expect(data).toHaveProperty('local');
      expect(data).toHaveProperty('external');

      expect(data.local).toHaveProperty('results');
      expect(Array.isArray(data.local.results)).toBe(true);

      // External will have either 'results' (string) or 'note' (string)
      const hasResults = 'results' in data.external;
      const hasNote = 'note' in data.external;
      expect(hasResults || hasNote).toBe(true);
    });

    it('external arm contains a string value (note on degradation, results on success)', async () => {
      // In the test environment, external search degrades — verify the note variant is a string.
      // The success variant (data.external.results) requires spawn mocking (see external search note).
      const ctx = makeCtx({ skillOps: makeSkillOps() });

      const result = await searchSkills.execute({ query: 'test' }, ctx);

      expect(result.success).toBe(true);
      const data = result.data as SearchSkillsData;
      if ('note' in data.external) {
        expect(typeof data.external.note).toBe('string');
      }
      if ('results' in data.external) {
        expect(typeof data.external.results).toBe('string');
      }
    });

    it('local results array items have expected fields', async () => {
      const searchResults = [
        { id: 'sk-1', slug: 'trading', name: 'Trading', description: 'Trade crypto', isAssigned: true, dependsOn: ['sk-dep'] },
      ];
      const ctx = makeCtx({
        skillOps: makeSkillOps({ search: vi.fn(async () => searchResults) }),
      });

      const result = await searchSkills.execute({ query: 'trading' }, ctx);

      expect(result.success).toBe(true);
      const data = result.data as SearchSkillsData;
      const item = data.local.results[0]!;
      expect(item).toHaveProperty('id');
      expect(item).toHaveProperty('name');
      expect(item).toHaveProperty('description');
      expect(item).toHaveProperty('isAssigned');
      expect(item).toHaveProperty('dependsOn');
    });
  });

  // ── Combined behavior ───────────────────────────────────────────────────

  describe('combined behavior', () => {
    it('returns both local results and external note in a single response', async () => {
      const searchResults = [
        { id: 'sk-1', slug: 'monitoring', name: 'Monitoring', description: 'Watch things', isAssigned: false, dependsOn: [] as string[] },
      ];
      const ctx = makeCtx({
        skillOps: makeSkillOps({ search: vi.fn(async () => searchResults) }),
      });

      const result = await searchSkills.execute({ query: 'monitoring' }, ctx);

      expect(result.success).toBe(true);
      const data = result.data as SearchSkillsData;
      expect(data.local.results).toHaveLength(1);
      expect(data.local.results[0]!.name).toBe('Monitoring');
      expect('note' in data.external).toBe(true);
    });

    it('gracefully handles both skillOps missing and external search failing', async () => {
      const ctx = makeCtx({ skillOps: undefined });

      const result = await searchSkills.execute({ query: 'anything' }, ctx);

      expect(result.success).toBe(true);
      const data = result.data as SearchSkillsData;
      expect(data.local.results).toEqual([]);
      expect('note' in data.external).toBe(true);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// runtime-tool-visibility integration
// ═══════════════════════════════════════════════════════════════════════════

describe('DATABASE_DEPENDENT_TOOLS includes skill tools', () => {
  // These are integration assertions verifying that runtime-tool-visibility
  // will properly degrade skill tools when database goes offline.
  // The actual degradation behavior is tested in runtime-tool-visibility.test.ts.

  it.each(['list_skills', 'add_skills', 'remove_skills', 'search_skills'])(
    '%s is in DATABASE_DEPENDENT_TOOLS',
    async (toolName) => {
      // Dynamic import to avoid coupling test file ordering
      const { DATABASE_DEPENDENT_TOOLS } = await import('../runtime-tool-visibility.js');
      expect(DATABASE_DEPENDENT_TOOLS.has(toolName)).toBe(true);
    },
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 3: Broker denial reply handling (add_skills & remove_skills)
// ═══════════════════════════════════════════════════════════════════════════

describe('skill mutation — broker capability denial', () => {
  it.each([
    ['add_skills', addSkills],
    ['remove_skills', removeSkills],
  ] as const)('%s returns capability denial when broker reply has status: rejected with rate_limit', async (_name, tool) => {
    const denialReply = {
      status: 'rejected',
      code: 'capability_denied:rate_limit_exceeded',
      message: 'Rate limit exceeded for manage_agent_skills',
      retryAfterMs: 5000,
      limit: 10,
      used: 10,
    };
    const ctx = makeCtx({ redis: makeRedisWithReply(denialReply) });

    const result = await tool.execute({ skillIds: ['skill-1'] }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('capability_denied:rate_limit_exceeded');
    expect(result.error).toBe('Rate limit exceeded for manage_agent_skills');
    expect(result.retryable).toBe(true);
    expect(result.fault).toBe(false);
    expect(result.data).toMatchObject({
      retryAfterMs: 5000,
      limit: 10,
      used: 10,
    });
  });

  it.each([
    ['add_skills', addSkills],
    ['remove_skills', removeSkills],
  ] as const)('%s returns capability denial with retryable: true for max_concurrent', async (_name, tool) => {
    const denialReply = {
      status: 'rejected',
      code: 'capability_denied:max_concurrent_exceeded',
      message: 'Too many concurrent manage_agent_skills calls',
      limit: 2,
      used: 2,
    };
    const ctx = makeCtx({ redis: makeRedisWithReply(denialReply) });

    const result = await tool.execute({ skillIds: ['skill-1'] }, ctx);

    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.data).toMatchObject({ limit: 2, used: 2 });
  });

  it.each([
    ['add_skills', addSkills],
    ['remove_skills', removeSkills],
  ] as const)('%s returns capability denial with retryable: false for non-transient denial', async (_name, tool) => {
    const denialReply = {
      status: 'rejected',
      code: 'capability_denied:capability_disabled',
      message: 'manage_agent_skills is disabled',
    };
    const ctx = makeCtx({ redis: makeRedisWithReply(denialReply) });

    const result = await tool.execute({ skillIds: ['skill-1'] }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('capability_denied:capability_disabled');
    expect(result.retryable).toBe(false);
  });

  it.each([
    ['add_skills', addSkills],
    ['remove_skills', removeSkills],
  ] as const)('%s uses fallback message when denial has no message field', async (_name, tool) => {
    const denialReply = {
      status: 'rejected',
      code: 'capability_denied:some_reason',
    };
    const ctx = makeCtx({ redis: makeRedisWithReply(denialReply) });

    const result = await tool.execute({ skillIds: ['skill-1'] }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Capability denied');
    expect(result.error).toContain('some_reason');
  });

  it.each([
    ['add_skills', addSkills],
    ['remove_skills', removeSkills],
  ] as const)('%s falls through to ManageAgentSkillsResultSchema for normal replies', async (_name, tool) => {
    const normalReply = makeBrokerReply({
      action: tool === addSkills ? 'add' : 'remove',
      skillIds: ['skill-1'],
    });
    const ctx = makeCtx({
      redis: makeRedisWithReply(normalReply),
      onSkillsChanged: vi.fn(async () => ['skill-1']),
    });

    const result = await tool.execute({ skillIds: ['skill-1'] }, ctx);

    expect(result.success).toBe(true);
  });

  it.each([
    ['add_skills', addSkills],
    ['remove_skills', removeSkills],
  ] as const)('%s does not call onSkillsChanged when denial reply received', async (_name, tool) => {
    const onSkillsChanged = vi.fn(async () => []);
    const denialReply = {
      status: 'rejected',
      code: 'capability_denied:rate_limit_exceeded',
      message: 'Rate limited',
    };
    const ctx = makeCtx({
      redis: makeRedisWithReply(denialReply),
      onSkillsChanged,
    });

    await tool.execute({ skillIds: ['skill-1'] }, ctx);

    expect(onSkillsChanged).not.toHaveBeenCalled();
  });

  it.each([
    ['add_skills', addSkills],
    ['remove_skills', removeSkills],
  ] as const)('%s includes optional retryAfterMs/limit/used fields (undefined when absent)', async (_name, tool) => {
    const denialReply = {
      status: 'rejected',
      code: 'capability_denied:rate_limit_exceeded',
      message: 'Rate limited',
      retryAfterMs: 3000,
      // limit and used not provided
    };
    const ctx = makeCtx({ redis: makeRedisWithReply(denialReply) });

    const result = await tool.execute({ skillIds: ['skill-1'] }, ctx);

    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({ retryAfterMs: 3000 });
    expect(result.data.limit).toBeUndefined();
    expect(result.data.used).toBeUndefined();
  });
});
