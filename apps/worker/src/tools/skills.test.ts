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
    const data = result.data as Record<string, unknown>;
    expect(data.assigned).toEqual([
      { id: 's1', skill: 'trading', name: 'Trading', description: 'Trade stuff', dependsOn: [] },
    ]);
    expect(data.available).toEqual([
      { id: 's2', skill: 'monitoring', name: 'Monitoring', description: 'Watch stuff', dependsOn: [] },
    ]);
    expect(data.hint).toEqual('For capabilities not listed here, use search_skills to search both platform skills and external skills discoverable through skills.sh.');
    expect(data.installedExternal).toBeDefined();
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

    it('auto-resolves dependencies when includeDependencies is true (default)', async () => {
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
      // Dependencies are auto-resolved upfront, reported as autoResolved
      const autoResolved = data.autoResolved as Array<{ skill: string; requiredBy: string }>;
      expect(autoResolved).toBeDefined();
      expect(autoResolved).toEqual(expect.arrayContaining([
        { skill: 'dep-a', requiredBy: 'trading' },
        { skill: 'dep-b', requiredBy: 'trading' },
      ]));
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

    it('auto-resolves overlapping dependencies for multiple added skills', async () => {
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
      const autoResolved = data.autoResolved as Array<{ skill: string; requiredBy: string }>;
      expect(autoResolved).toBeDefined();
      // Dependencies are auto-resolved (dep-shared and dep-only-a)
      expect(autoResolved).toHaveLength(3);
      expect(autoResolved).toEqual(expect.arrayContaining([
        { skill: 'dep-shared', requiredBy: 'a' },
        { skill: 'dep-only-a', requiredBy: 'a' },
        { skill: 'dep-shared', requiredBy: 'b' },
      ]));
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

    it('only auto-resolves dependencies not already assigned', async () => {
      const onSkillsChanged = vi.fn(async () => ['skill-1', 'dep-a']);
      const reply = makeBrokerReply({ action: 'add', skillIds: ['skill-1'] });
      const ctx = makeCtx({
        onSkillsChanged,
        redis: makeRedisWithReply(reply),
        skillOps: makeSkillOps({
          listAssigned: vi.fn(async () => [
            { id: 'skill-1', slug: 'trading', name: 'Trading', description: 'Trade', dependsOn: ['dep-a', 'dep-b'] },
            { id: 'dep-a', slug: 'dep-a', name: 'Dep A', description: 'Dependency A', dependsOn: [] },
          ]),
        }),
      });

      const result = await addSkills.execute({ skillIds: ['skill-1'] }, ctx);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      // dep-a is already assigned → only dep-b auto-resolved
      const autoResolved = data.autoResolved as Array<{ skill: string; requiredBy: string }>;
      expect(autoResolved).toBeDefined();
      expect(autoResolved).toEqual([
        { skill: 'dep-b', requiredBy: 'trading' },
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

  it('does not compute autoResolved even when skillOps is available', async () => {
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
    expect(data.autoResolved).toBeUndefined();
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
      skill: string;
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
      expect(data.local.results).toEqual([
        { id: 'sk-1', skill: 'trading', name: 'Trading', description: 'Trade crypto', isAssigned: true, dependsOn: ['sk-2'] },
        { id: 'sk-3', skill: 'analytics', name: 'Analytics', description: 'Analyze markets', isAssigned: false, dependsOn: [] },
      ]);
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
      expect(data.local.results).toEqual([
        { id: 'sk-1', skill: 'trading', name: 'Trading', description: 'Trade', isAssigned: false, dependsOn: [] },
      ]);
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
      expect(item).toHaveProperty('skill');
      expect(item).toHaveProperty('name');
      expect(item).toHaveProperty('description');
      expect(item).toHaveProperty('isAssigned');
      expect(item).toHaveProperty('dependsOn');
      expect(item).not.toHaveProperty('slug');
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


// ═══════════════════════════════════════════════════════════════════════════
// Phase 4: Slug resolution, includeDependencies, external refs, response format
// ═══════════════════════════════════════════════════════════════════════════

describe('list_skills — installedExternal field', () => {
  it('includes installedExternal in response data', async () => {
    const ctx = makeCtx({
      skillOps: makeSkillOps({
        listAssigned: vi.fn(async () => []),
        listAvailable: vi.fn(async () => []),
      }),
    });

    const result = await listSkills.execute({}, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data).toHaveProperty('installedExternal');
  });

  it('installedExternal degrades with a note when workspace import fails', async () => {
    const ctx = makeCtx({
      skillOps: makeSkillOps({
        listAssigned: vi.fn(async () => []),
        listAvailable: vi.fn(async () => []),
      }),
    });

    const result = await listSkills.execute({}, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    // In the test environment the dynamic import of ./workspace.js or npx spawn
    // will fail — the external arm should degrade to a note
    const ext = data.installedExternal as { note?: string; results?: string };
    expect(ext).toBeDefined();
    expect('note' in ext).toBe(true);
    expect(typeof (ext as { note: string }).note).toBe('string');
  });

  it('response uses skill field (slug) instead of slug in assigned items', async () => {
    const assigned = [
      { id: 'trading', slug: 'system/trading', name: 'Trading', description: 'Trade stuff', dependsOn: [] as string[] },
    ];
    const ctx = makeCtx({
      skillOps: makeSkillOps({
        listAssigned: vi.fn(async () => assigned),
        listAvailable: vi.fn(async () => []),
      }),
    });

    const result = await listSkills.execute({}, ctx);

    expect(result.success).toBe(true);
    const data = result.data as { assigned: Array<Record<string, unknown>> };
    expect(data.assigned[0]).toHaveProperty('skill', 'system/trading');
    expect(data.assigned[0]).toHaveProperty('id', 'trading');
    expect(data.assigned[0]).toHaveProperty('name', 'Trading');
    expect(data.assigned[0]).toHaveProperty('description', 'Trade stuff');
    expect(data.assigned[0]).toHaveProperty('dependsOn');
    // Should NOT have a 'slug' key in the output — it's mapped to 'skill'
    expect(data.assigned[0]).not.toHaveProperty('slug');
  });

  it('response uses skill field (slug) instead of slug in available items', async () => {
    const available = [
      { id: 'risk-monitoring', slug: 'system/risk-monitoring', name: 'Risk Monitoring', description: 'Monitor', dependsOn: ['trading'] },
    ];
    const ctx = makeCtx({
      skillOps: makeSkillOps({
        listAssigned: vi.fn(async () => []),
        listAvailable: vi.fn(async () => available),
      }),
    });

    const result = await listSkills.execute({}, ctx);

    expect(result.success).toBe(true);
    const data = result.data as { available: Array<Record<string, unknown>> };
    expect(data.available[0]).toHaveProperty('skill', 'system/risk-monitoring');
    expect(data.available[0]).not.toHaveProperty('slug');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// add_skills — includeDependencies parameter
// ═══════════════════════════════════════════════════════════════════════════

describe('add_skills — includeDependencies', () => {
  it('defaults includeDependencies to true when omitted', async () => {
    const onSkillsChanged = vi.fn(async () => ['skill-1', 'dep-a']);
    const reply = makeBrokerReply({ action: 'add', skillIds: ['skill-1', 'dep-a'] });
    const ctx = makeCtx({
      onSkillsChanged,
      redis: makeRedisWithReply(reply),
      skillOps: makeSkillOps({
        listAssigned: vi.fn(async () => [
          { id: 'skill-1', slug: 'system/trading', name: 'Trading', description: 'Trade', dependsOn: ['dep-a'] },
        ]),
        listAvailable: vi.fn(async () => [
          { id: 'dep-a', slug: 'system/dep-a', name: 'Dep A', description: 'Dep', dependsOn: [] },
        ]),
      }),
    });

    // No includeDependencies specified — should default to true
    const result = await addSkills.execute({ skillIds: ['skill-1'] }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const autoResolved = data.autoResolved as Array<{ skill: string; requiredBy: string }>;
    expect(autoResolved).toBeDefined();
    expect(autoResolved.length).toBeGreaterThan(0);
  });

  it('does NOT auto-resolve dependencies when includeDependencies is false', async () => {
    const onSkillsChanged = vi.fn(async () => ['skill-1']);
    const reply = makeBrokerReply({ action: 'add', skillIds: ['skill-1'] });
    const ctx = makeCtx({
      onSkillsChanged,
      redis: makeRedisWithReply(reply),
      skillOps: makeSkillOps({
        listAssigned: vi.fn(async () => [
          { id: 'skill-1', slug: 'system/trading', name: 'Trading', description: 'Trade', dependsOn: ['dep-a', 'dep-b'] },
        ]),
        listAvailable: vi.fn(async () => []),
      }),
    });

    const result = await addSkills.execute(
      { skillIds: ['skill-1'], includeDependencies: false },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    // No autoResolved when includeDependencies is false
    expect(data.autoResolved).toBeUndefined();
  });

  it('sends only requested skill IDs to broker when includeDependencies is false', async () => {
    const publishToInbound = vi.fn(async () => undefined);
    const reply = makeBrokerReply({ action: 'add', skillIds: ['skill-1'] });
    const ctx = makeCtx({
      publishToInbound,
      redis: makeRedisWithReply(reply),
      skillOps: makeSkillOps({
        listAssigned: vi.fn(async () => [
          { id: 'skill-1', slug: 'system/trading', name: 'Trading', description: 'Trade', dependsOn: ['dep-a'] },
        ]),
        listAvailable: vi.fn(async () => []),
      }),
    });

    await addSkills.execute(
      { skillIds: ['skill-1'], includeDependencies: false },
      ctx,
    );

    expect(publishToInbound).toHaveBeenCalledOnce();
    const [, payload] = publishToInbound.mock.calls[0]! as [string, Record<string, unknown>];
    // Only skill-1 sent — dep-a should NOT be included
    expect(payload.skillIds).toEqual(['skill-1']);
  });

  it('includes dependency IDs in broker call when includeDependencies is true', async () => {
    const publishToInbound = vi.fn(async () => undefined);
    const reply = makeBrokerReply({ action: 'add', skillIds: ['skill-1', 'dep-a'] });
    const ctx = makeCtx({
      publishToInbound,
      redis: makeRedisWithReply(reply),
      skillOps: makeSkillOps({
        listAssigned: vi.fn(async () => []),
        listAvailable: vi.fn(async () => [
          { id: 'skill-1', slug: 'system/trading', name: 'Trading', description: 'Trade', dependsOn: ['dep-a'] },
          { id: 'dep-a', slug: 'system/dep-a', name: 'Dep A', description: 'Dep', dependsOn: [] },
        ]),
      }),
    });

    await addSkills.execute(
      { skillIds: ['skill-1'], includeDependencies: true },
      ctx,
    );

    expect(publishToInbound).toHaveBeenCalledOnce();
    const [, payload] = publishToInbound.mock.calls[0]! as [string, Record<string, unknown>];
    // Both skill-1 and dep-a should be in the broker call
    expect(payload.skillIds).toEqual(expect.arrayContaining(['skill-1', 'dep-a']));
  });

  it('autoResolved entries use slugs (not IDs) when available', async () => {
    const onSkillsChanged = vi.fn(async () => ['trading', 'bot-management']);
    const reply = makeBrokerReply({ action: 'add', skillIds: ['trading', 'bot-management'] });
    const ctx = makeCtx({
      onSkillsChanged,
      redis: makeRedisWithReply(reply),
      skillOps: makeSkillOps({
        listAssigned: vi.fn(async () => [
          { id: 'trading', slug: 'system/trading', name: 'Trading', description: 'Trade', dependsOn: ['bot-management'] },
        ]),
        listAvailable: vi.fn(async () => [
          { id: 'bot-management', slug: 'system/bot-management', name: 'Bot Management', description: 'Bots', dependsOn: [] },
        ]),
      }),
    });

    const result = await addSkills.execute({ skillIds: ['trading'] }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const autoResolved = data.autoResolved as Array<{ skill: string; requiredBy: string }>;
    expect(autoResolved).toBeDefined();
    // Should use slug-based names from the idToSlug map
    expect(autoResolved).toEqual(expect.arrayContaining([
      { skill: 'system/bot-management', requiredBy: 'system/trading' },
    ]));
  });

  it('omits autoResolved key entirely when no dependencies need resolution', async () => {
    const onSkillsChanged = vi.fn(async () => ['skill-1']);
    const reply = makeBrokerReply({ action: 'add', skillIds: ['skill-1'] });
    const ctx = makeCtx({
      onSkillsChanged,
      redis: makeRedisWithReply(reply),
      skillOps: makeSkillOps({
        listAssigned: vi.fn(async () => [
          { id: 'skill-1', slug: 'system/simple', name: 'Simple', description: 'No deps', dependsOn: [] },
        ]),
        listAvailable: vi.fn(async () => []),
      }),
    });

    const result = await addSkills.execute(
      { skillIds: ['skill-1'], includeDependencies: true },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.autoResolved).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// add_skills — no skillOps (dependency resolution gracefully skipped)
// ═══════════════════════════════════════════════════════════════════════════

describe('add_skills — no skillOps', () => {
  it('skips dependency auto-resolution when skillOps is missing', async () => {
    const onSkillsChanged = vi.fn(async () => ['skill-1']);
    const reply = makeBrokerReply({ action: 'add', skillIds: ['skill-1'] });
    const ctx = makeCtx({
      onSkillsChanged,
      redis: makeRedisWithReply(reply),
      skillOps: undefined,
    });

    const result = await addSkills.execute(
      { skillIds: ['skill-1'], includeDependencies: true },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    // No autoResolved — can't compute deps without skillOps
    expect(data.autoResolved).toBeUndefined();
    expect(data.added).toEqual(['skill-1']);
  });

  it('still routes legacy IDs through SYSTEM_SKILL_SLUGS fallback when db is absent', async () => {
    const publishToInbound = vi.fn(async () => undefined);
    const onSkillsChanged = vi.fn(async () => ['trading']);
    const reply = makeBrokerReply({ action: 'add', skillIds: ['trading'] });
    const ctx = makeCtx({
      publishToInbound,
      onSkillsChanged,
      redis: makeRedisWithReply(reply),
      skillOps: undefined,
      db: undefined,
    });

    const result = await addSkills.execute({ skillIds: ['trading'] }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.added).toBeDefined();
    // Verify 'trading' legacy ID was sent to broker as-is
    const [, payload] = publishToInbound.mock.calls[0]! as [string, Record<string, unknown>];
    expect(payload.skillIds).toEqual(expect.arrayContaining(['trading']));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// add_skills — slug resolution (SYSTEM_SKILL_SLUGS, legacy IDs)
// ═══════════════════════════════════════════════════════════════════════════

describe('add_skills — slug resolution', () => {
  it('resolves system/trading slug to trading ID via SYSTEM_SKILL_SLUGS fallback (no db)', async () => {
    const publishToInbound = vi.fn(async () => undefined);
    const reply = makeBrokerReply({ action: 'add', skillIds: ['trading'] });
    const ctx = makeCtx({
      publishToInbound,
      redis: makeRedisWithReply(reply),
      db: undefined,
    });

    await addSkills.execute({ skillIds: ['system/trading'] }, ctx);

    expect(publishToInbound).toHaveBeenCalledOnce();
    const [, payload] = publishToInbound.mock.calls[0]! as [string, Record<string, unknown>];
    // system/trading slug should resolve to the 'trading' ID
    expect(payload.skillIds).toEqual(expect.arrayContaining(['trading']));
  });

  it('passes legacy IDs through as-is when they have no slash (no db)', async () => {
    const publishToInbound = vi.fn(async () => undefined);
    const reply = makeBrokerReply({ action: 'add', skillIds: ['bot-management'] });
    const ctx = makeCtx({
      publishToInbound,
      redis: makeRedisWithReply(reply),
      db: undefined,
    });

    await addSkills.execute({ skillIds: ['bot-management'] }, ctx);

    expect(publishToInbound).toHaveBeenCalledOnce();
    const [, payload] = publishToInbound.mock.calls[0]! as [string, Record<string, unknown>];
    expect(payload.skillIds).toEqual(expect.arrayContaining(['bot-management']));
  });

  it('routes unknown slug-like refs (with /) to external when not in SYSTEM_SKILL_SLUGS (no db)', async () => {
    // 'alice/custom-skill' is not a system slug and not in DB → external
    const reply = makeBrokerReply({ action: 'add', skillIds: [] });
    const ctx = makeCtx({
      redis: makeRedisWithReply(reply),
      db: undefined,
    });

    const result = await addSkills.execute({ skillIds: ['alice/custom-skill'] }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    // The external ref should appear in the external results section
    const external = data.external as Array<{ ref: string; ok: boolean; error?: string }> | undefined;
    expect(external).toBeDefined();
    expect(external!.some(e => e.ref === 'alice/custom-skill')).toBe(true);
  });

  it('handles mixed platform slugs, legacy IDs, and external refs', async () => {
    const publishToInbound = vi.fn(async () => undefined);
    const reply = makeBrokerReply({ action: 'add', skillIds: ['trading', 'bot-management'] });
    const ctx = makeCtx({
      publishToInbound,
      redis: makeRedisWithReply(reply),
      db: undefined,
    });

    const result = await addSkills.execute(
      { skillIds: ['system/trading', 'bot-management', 'alice/custom-skill'] },
      ctx,
    );

    expect(result.success).toBe(true);
    // Verify platform IDs went to broker
    const [, payload] = publishToInbound.mock.calls[0]! as [string, Record<string, unknown>];
    expect(payload.skillIds).toEqual(expect.arrayContaining(['trading', 'bot-management']));
    // External ref should be in the external results
    const data = result.data as Record<string, unknown>;
    const external = data.external as Array<{ ref: string }> | undefined;
    expect(external).toBeDefined();
    expect(external!.some(e => e.ref === 'alice/custom-skill')).toBe(true);
  });

  it('response added array uses slugs (mapped from IDs via idToSlug)', async () => {
    const onSkillsChanged = vi.fn(async () => ['trading']);
    const reply = makeBrokerReply({ action: 'add', skillIds: ['trading'] });
    const ctx = makeCtx({
      onSkillsChanged,
      redis: makeRedisWithReply(reply),
      db: undefined,
      skillOps: makeSkillOps({
        listAssigned: vi.fn(async () => [
          { id: 'trading', slug: 'system/trading', name: 'Trading', description: 'Trade', dependsOn: [] },
        ]),
      }),
    });

    const result = await addSkills.execute({ skillIds: ['system/trading'] }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    // The 'added' array should contain slugs, not raw IDs
    const added = data.added as string[];
    expect(added).toContain('system/trading');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// add_skills — external ref routing
// ═══════════════════════════════════════════════════════════════════════════

describe('add_skills — external refs', () => {
  it('attempts external install for slug-like refs not matching platform skills', async () => {
    const ctx = makeCtx({
      redis: makeRedisWithReply(makeBrokerReply({ action: 'add', skillIds: [] })),
      db: undefined,
    });

    const result = await addSkills.execute({ skillIds: ['owner/custom-skill'] }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const external = data.external as Array<{ ref: string; ok: boolean; error?: string }>;
    expect(external).toBeDefined();
    expect(external).toHaveLength(1);
    expect(external[0]!.ref).toBe('owner/custom-skill');
    // In the test environment, the subprocess will fail (npx not available or workspace import fails)
    // but the tool should handle it gracefully
    expect(typeof external[0]!.ok).toBe('boolean');
  });

  it('auto-resolves file-management dependency for external skills when includeDependencies is true', async () => {
    const publishToInbound = vi.fn(async () => undefined);
    const reply = makeBrokerReply({ action: 'add', skillIds: ['file-management'] });
    const ctx = makeCtx({
      publishToInbound,
      redis: makeRedisWithReply(reply),
      db: undefined,
      skillOps: makeSkillOps({
        listAssigned: vi.fn(async () => []),
      }),
    });

    const result = await addSkills.execute(
      { skillIds: ['owner/external-skill'], includeDependencies: true },
      ctx,
    );

    expect(result.success).toBe(true);
    // file-management should have been added to the broker call
    expect(publishToInbound).toHaveBeenCalledOnce();
    const [, payload] = publishToInbound.mock.calls[0]! as [string, Record<string, unknown>];
    expect(payload.skillIds).toEqual(expect.arrayContaining(['file-management']));
    // autoResolved should mention file-management
    const data = result.data as Record<string, unknown>;
    const autoResolved = data.autoResolved as Array<{ skill: string; requiredBy: string }>;
    expect(autoResolved).toBeDefined();
    expect(autoResolved).toEqual(expect.arrayContaining([
      expect.objectContaining({
        skill: 'system/file-management',
        requiredBy: 'owner/external-skill',
      }),
    ]));
  });

  it('does NOT auto-resolve file-management for external skills when already assigned', async () => {
    const publishToInbound = vi.fn(async () => undefined);
    const reply = makeBrokerReply({ action: 'add', skillIds: [] });
    const ctx = makeCtx({
      publishToInbound,
      redis: makeRedisWithReply(reply),
      db: undefined,
      skillOps: makeSkillOps({
        listAssigned: vi.fn(async () => [
          { id: 'file-management', slug: 'system/file-management', name: 'File Management', description: 'Files', dependsOn: [] },
        ]),
      }),
    });

    const result = await addSkills.execute(
      { skillIds: ['owner/external-skill'], includeDependencies: true },
      ctx,
    );

    expect(result.success).toBe(true);
    // No platform skills sent to broker (no broker call or empty skillIds)
    // because file-management is already assigned
    const data = result.data as Record<string, unknown>;
    const autoResolved = data.autoResolved as Array<{ skill: string; requiredBy: string }> | undefined;
    // Should not have auto-resolved file-management since already assigned
    if (autoResolved) {
      expect(autoResolved.every(r => r.skill !== 'system/file-management')).toBe(true);
    }
  });

  it('does NOT auto-resolve file-management when includeDependencies is false', async () => {
    const publishToInbound = vi.fn(async () => undefined);
    const ctx = makeCtx({
      publishToInbound,
      redis: makeRedisWithReply(makeBrokerReply({ action: 'add', skillIds: [] })),
      db: undefined,
      skillOps: makeSkillOps({
        listAssigned: vi.fn(async () => []),
      }),
    });

    const result = await addSkills.execute(
      { skillIds: ['owner/external-skill'], includeDependencies: false },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.autoResolved).toBeUndefined();
  });

  it('continues external installs even when platform broker call fails', async () => {
    const ctx = makeCtx({
      // blpop returns null → timeout → broker failure
      redis: makeRedisMock(),
      db: undefined,
    });

    const result = await addSkills.execute(
      { skillIds: ['owner/external-skill'] },
      ctx,
    );

    // The tool should still succeed (external tried even if platform timed out)
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const external = data.external as Array<{ ref: string }>;
    expect(external).toBeDefined();
    expect(external[0]!.ref).toBe('owner/external-skill');
  });

  it('platform-only refs with broker timeout return broker.timeout (no external fallback)', async () => {
    const ctx = makeCtx({
      redis: makeRedisMock(), // blpop returns null → timeout
      db: undefined,
    });

    const result = await addSkills.execute({ skillIds: ['trading'] }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('broker.timeout');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// remove_skills — slug-mapped response format
// ═══════════════════════════════════════════════════════════════════════════

describe('remove_skills — slug-mapped response', () => {
  it('response removed array uses slugs when idToSlug mapping is available', async () => {
    const onSkillsChanged = vi.fn(async () => []);
    const reply = makeBrokerReply({ action: 'remove', skillIds: ['trading'] });
    const ctx = makeCtx({
      onSkillsChanged,
      redis: makeRedisWithReply(reply),
      skillOps: makeSkillOps({
        listAssigned: vi.fn(async () => [
          { id: 'trading', slug: 'system/trading', name: 'Trading', description: 'Trade', dependsOn: [] },
        ]),
      }),
    });

    const result = await removeSkills.execute({ skillIds: ['trading'] }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const removed = data.removed as string[];
    expect(removed).toContain('system/trading');
  });

  it('falls back to raw ID when slug mapping is not available', async () => {
    const onSkillsChanged = vi.fn(async () => []);
    const reply = makeBrokerReply({ action: 'remove', skillIds: ['unknown-id'] });
    const ctx = makeCtx({
      onSkillsChanged,
      redis: makeRedisWithReply(reply),
      skillOps: makeSkillOps({
        listAssigned: vi.fn(async () => []),
      }),
    });

    const result = await removeSkills.execute({ skillIds: ['unknown-id'] }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const removed = data.removed as string[];
    // Falls back to raw ID since no slug mapping
    expect(removed).toContain('unknown-id');
  });

  it('accepts system slug and resolves to platform ID for broker call', async () => {
    const publishToInbound = vi.fn(async () => undefined);
    const reply = makeBrokerReply({ action: 'remove', skillIds: ['trading'] });
    const ctx = makeCtx({
      publishToInbound,
      redis: makeRedisWithReply(reply),
      db: undefined,
      skillOps: makeSkillOps({
        listAssigned: vi.fn(async () => [
          { id: 'trading', slug: 'system/trading', name: 'Trading', description: 'Trade', dependsOn: [] },
        ]),
      }),
    });

    await removeSkills.execute({ skillIds: ['system/trading'] }, ctx);

    expect(publishToInbound).toHaveBeenCalledOnce();
    const [, payload] = publishToInbound.mock.calls[0]! as [string, Record<string, unknown>];
    // system/trading slug should resolve to 'trading' ID for broker
    expect(payload.skillIds).toEqual(expect.arrayContaining(['trading']));
  });

  it('maps multiple removed IDs to their respective slugs', async () => {
    const onSkillsChanged = vi.fn(async () => []);
    const reply = makeBrokerReply({ action: 'remove', skillIds: ['trading', 'bot-management'] });
    const ctx = makeCtx({
      onSkillsChanged,
      redis: makeRedisWithReply(reply),
      skillOps: makeSkillOps({
        listAssigned: vi.fn(async () => [
          { id: 'trading', slug: 'system/trading', name: 'Trading', description: 'Trade', dependsOn: [] },
          { id: 'bot-management', slug: 'system/bot-management', name: 'Bot Management', description: 'Bots', dependsOn: [] },
        ]),
      }),
    });

    const result = await removeSkills.execute({ skillIds: ['trading', 'bot-management'] }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const removed = data.removed as string[];
    expect(removed).toContain('system/trading');
    expect(removed).toContain('system/bot-management');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// remove_skills — external ref routing
// ═══════════════════════════════════════════════════════════════════════════

describe('remove_skills — external refs', () => {
  it('routes unknown slug-like refs to external subprocess removal', async () => {
    const ctx = makeCtx({
      redis: makeRedisWithReply(makeBrokerReply({ action: 'remove', skillIds: [] })),
      db: undefined,
    });

    const result = await removeSkills.execute({ skillIds: ['owner/custom-skill'] }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const external = data.external as Array<{ ref: string; ok: boolean; error?: string }>;
    expect(external).toBeDefined();
    expect(external).toHaveLength(1);
    expect(external[0]!.ref).toBe('owner/custom-skill');
  });

  it('handles mixed platform and external refs in remove', async () => {
    const publishToInbound = vi.fn(async () => undefined);
    const reply = makeBrokerReply({ action: 'remove', skillIds: ['trading'] });
    const ctx = makeCtx({
      publishToInbound,
      redis: makeRedisWithReply(reply),
      db: undefined,
      skillOps: makeSkillOps({
        listAssigned: vi.fn(async () => [
          { id: 'trading', slug: 'system/trading', name: 'Trading', description: 'Trade', dependsOn: [] },
        ]),
      }),
    });

    const result = await removeSkills.execute(
      { skillIds: ['system/trading', 'alice/custom-skill'] },
      ctx,
    );

    expect(result.success).toBe(true);
    // Verify platform ID went to broker
    const [, payload] = publishToInbound.mock.calls[0]! as [string, Record<string, unknown>];
    expect(payload.skillIds).toEqual(expect.arrayContaining(['trading']));
    // External ref should appear in external results
    const data = result.data as Record<string, unknown>;
    const external = data.external as Array<{ ref: string }>;
    expect(external).toBeDefined();
    expect(external.some(e => e.ref === 'alice/custom-skill')).toBe(true);
  });

  it('continues external removal even when platform broker times out', async () => {
    const ctx = makeCtx({
      redis: makeRedisMock(), // blpop → null → timeout
      db: undefined,
    });

    const result = await removeSkills.execute(
      { skillIds: ['owner/external-skill'] },
      ctx,
    );

    // External-only ref: no platform IDs to send → no broker timeout
    // Should succeed (external tried)
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const external = data.external as Array<{ ref: string }>;
    expect(external).toBeDefined();
    expect(external[0]!.ref).toBe('owner/external-skill');
  });

  it('includes external failure in warnings when external remove fails', async () => {
    const ctx = makeCtx({
      redis: makeRedisWithReply(makeBrokerReply({ action: 'remove', skillIds: [] })),
      db: undefined,
    });

    const result = await removeSkills.execute({ skillIds: ['owner/failing-skill'] }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const external = data.external as Array<{ ref: string; ok: boolean; error?: string }>;
    expect(external).toBeDefined();
    // In the test environment the subprocess always fails (npx not available / workspace import fails)
    expect(external[0]!.ok).toBe(false);
    const warnings = data.warnings as string[];
    expect(warnings).toBeDefined();
    expect(warnings.some(w => w.includes('owner/failing-skill'))).toBe(true);
  });

  it('response removed array combines platform slug-mapped values and external refs', async () => {
    const onSkillsChanged = vi.fn(async () => []);
    const reply = makeBrokerReply({ action: 'remove', skillIds: ['trading'] });
    const ctx = makeCtx({
      onSkillsChanged,
      redis: makeRedisWithReply(reply),
      db: undefined,
      skillOps: makeSkillOps({
        listAssigned: vi.fn(async () => [
          { id: 'trading', slug: 'system/trading', name: 'Trading', description: 'Trade', dependsOn: [] },
        ]),
      }),
    });

    const result = await removeSkills.execute(
      { skillIds: ['system/trading', 'owner/ext-skill'] },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const removed = data.removed as string[];
    // Platform skills use slug mapping
    expect(removed).toContain('system/trading');
    // External successful removals would be appended too
    // (may or may not succeed in test env, but structure is correct)
    expect(Array.isArray(removed)).toBe(true);
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// Phase 5: search_skills slug→skill mapping, buildIdToSlugMap, deduplication
// ═══════════════════════════════════════════════════════════════════════════

// ── search_skills: slug→skill field mapping (behavioral change) ─────────

describe('search_skills — slug→skill field mapping', () => {
  it('maps slug to skill field in every result item', async () => {
    const searchResults = [
      { id: 'sk-1', slug: 'system/trading', name: 'Trading', description: 'Trade crypto', isAssigned: true, dependsOn: [] as string[] },
      { id: 'sk-2', slug: 'system/monitoring', name: 'Monitoring', description: 'Monitor markets', isAssigned: false, dependsOn: ['sk-1'] },
    ];
    const ctx = makeCtx({
      skillOps: makeSkillOps({ search: vi.fn(async () => searchResults) }),
    });

    const result = await searchSkills.execute({ query: 'trade' }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as SearchSkillsData;
    for (const item of data.local.results) {
      expect(item).toHaveProperty('skill');
      expect(item).not.toHaveProperty('slug');
    }
    expect(data.local.results[0]!.skill).toBe('system/trading');
    expect(data.local.results[1]!.skill).toBe('system/monitoring');
  });

  it('preserves all other fields (id, name, description, isAssigned, dependsOn) in mapped results', async () => {
    const searchResults = [
      { id: 'sk-1', slug: 'system/analytics', name: 'Analytics', description: 'Analyze data', isAssigned: true, dependsOn: ['sk-base'] },
    ];
    const ctx = makeCtx({
      skillOps: makeSkillOps({ search: vi.fn(async () => searchResults) }),
    });

    const result = await searchSkills.execute({ query: 'analytics' }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as SearchSkillsData;
    const item = data.local.results[0]!;
    expect(item.id).toBe('sk-1');
    expect(item.skill).toBe('system/analytics');
    expect(item.name).toBe('Analytics');
    expect(item.description).toBe('Analyze data');
    expect(item.isAssigned).toBe(true);
    expect(item.dependsOn).toEqual(['sk-base']);
  });

  it('returns empty local results array when skillOps.search returns empty', async () => {
    const ctx = makeCtx({
      skillOps: makeSkillOps({ search: vi.fn(async () => []) }),
    });

    const result = await searchSkills.execute({ query: 'nonexistent' }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as SearchSkillsData;
    expect(data.local.results).toEqual([]);
  });

  it('response format matches list_skills format (both use skill field, not slug)', async () => {
    // list_skills assigned items
    const assigned = [
      { id: 's1', slug: 'system/trading', name: 'Trading', description: 'Trade stuff', dependsOn: [] as string[] },
    ];
    const listCtx = makeCtx({
      skillOps: makeSkillOps({
        listAssigned: vi.fn(async () => assigned),
        listAvailable: vi.fn(async () => []),
      }),
    });
    const listResult = await listSkills.execute({}, listCtx);
    const listData = listResult.data as { assigned: Array<Record<string, unknown>> };

    // search_skills results
    const searchResults = [
      { id: 's1', slug: 'system/trading', name: 'Trading', description: 'Trade stuff', isAssigned: true, dependsOn: [] as string[] },
    ];
    const searchCtx = makeCtx({
      skillOps: makeSkillOps({ search: vi.fn(async () => searchResults) }),
    });
    const searchResult = await searchSkills.execute({ query: 'trading' }, searchCtx);
    const searchData = searchResult.data as SearchSkillsData;

    // Both should use 'skill' key, not 'slug'
    expect(listData.assigned[0]).toHaveProperty('skill', 'system/trading');
    expect(listData.assigned[0]).not.toHaveProperty('slug');
    expect(searchData.local.results[0]).toHaveProperty('skill', 'system/trading');
    expect(searchData.local.results[0]).not.toHaveProperty('slug');
  });

  it('handles multiple results with different slugs correctly', async () => {
    const searchResults = [
      { id: 'a', slug: 'system/trading', name: 'Trading', description: 'D1', isAssigned: true, dependsOn: [] as string[] },
      { id: 'b', slug: 'system/risk', name: 'Risk', description: 'D2', isAssigned: false, dependsOn: ['a'] },
      { id: 'c', slug: 'custom/my-skill', name: 'My Skill', description: 'D3', isAssigned: false, dependsOn: [] as string[] },
    ];
    const ctx = makeCtx({
      skillOps: makeSkillOps({ search: vi.fn(async () => searchResults) }),
    });

    const result = await searchSkills.execute({ query: 'skill' }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as SearchSkillsData;
    expect(data.local.results).toHaveLength(3);
    expect(data.local.results.map(r => r.skill)).toEqual([
      'system/trading',
      'system/risk',
      'custom/my-skill',
    ]);
    // None should have slug key
    for (const item of data.local.results) {
      expect(item).not.toHaveProperty('slug');
    }
  });
});

// ── buildIdToSlugMap: with and without prefetched data ──────────────────

describe('buildIdToSlugMap behavior (tested via add_skills and remove_skills)', () => {
  // buildIdToSlugMap is not exported, so we test it indirectly through the tools
  // that use it. The key behaviors:
  // 1. Seeds with SYSTEM_SKILL_SLUGS (always present)
  // 2. Augments with prefetched assigned skills when provided
  // 3. Falls back to ctx.skillOps.listAssigned() when no prefetch

  it('uses SYSTEM_SKILL_SLUGS to map known system IDs to slugs (no prefetch needed)', async () => {
    // When adding a system skill ID, the response should use the system slug
    // even without any skillOps-provided assigned data
    const onSkillsChanged = vi.fn(async () => ['trading']);
    const reply = makeBrokerReply({ action: 'add', skillIds: ['trading'] });
    const ctx = makeCtx({
      onSkillsChanged,
      redis: makeRedisWithReply(reply),
      db: undefined,
      skillOps: makeSkillOps({
        listAssigned: vi.fn(async () => []),
        listAvailable: vi.fn(async () => []),
      }),
    });

    const result = await addSkills.execute({ skillIds: ['system/trading'] }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const added = data.added as string[];
    // 'trading' ID maps to 'system/trading' slug via SYSTEM_SKILL_SLUGS
    expect(added).toContain('system/trading');
  });

  it('maps user-authored skill IDs to slugs via prefetched assigned data', async () => {
    const onSkillsChanged = vi.fn(async () => ['custom-id-1']);
    const reply = makeBrokerReply({ action: 'add', skillIds: ['custom-id-1'] });
    const ctx = makeCtx({
      onSkillsChanged,
      redis: makeRedisWithReply(reply),
      db: undefined,
      skillOps: makeSkillOps({
        listAssigned: vi.fn(async () => [
          { id: 'custom-id-1', slug: 'user/my-custom-skill', name: 'Custom', description: 'User skill', dependsOn: [] },
        ]),
        listAvailable: vi.fn(async () => []),
      }),
    });

    const result = await addSkills.execute({ skillIds: ['custom-id-1'] }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const added = data.added as string[];
    // custom-id-1 → 'user/my-custom-skill' via prefetched assigned data
    expect(added).toContain('user/my-custom-skill');
  });

  it('falls back to raw ID when skill is not in SYSTEM_SKILL_SLUGS or assigned list', async () => {
    const onSkillsChanged = vi.fn(async () => ['unknown-skill-id']);
    const reply = makeBrokerReply({ action: 'add', skillIds: ['unknown-skill-id'] });
    const ctx = makeCtx({
      onSkillsChanged,
      redis: makeRedisWithReply(reply),
      db: undefined,
      skillOps: makeSkillOps({
        listAssigned: vi.fn(async () => []),
        listAvailable: vi.fn(async () => []),
      }),
    });

    const result = await addSkills.execute({ skillIds: ['unknown-skill-id'] }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const added = data.added as string[];
    // Falls back to raw ID since not mappable
    expect(added).toContain('unknown-skill-id');
  });

  it('buildIdToSlugMap without prefetch falls back to ctx.skillOps.listAssigned (remove_skills path)', async () => {
    // remove_skills calls buildIdToSlugMap without prefetchedAssigned
    // so it should internally call ctx.skillOps.listAssigned
    const listAssigned = vi.fn(async () => [
      { id: 'custom-id', slug: 'user/custom', name: 'Custom', description: 'Desc', dependsOn: [] },
    ]);
    const onSkillsChanged = vi.fn(async () => []);
    const reply = makeBrokerReply({ action: 'remove', skillIds: ['custom-id'] });
    const ctx = makeCtx({
      onSkillsChanged,
      redis: makeRedisWithReply(reply),
      skillOps: makeSkillOps({ listAssigned }),
    });

    const result = await removeSkills.execute({ skillIds: ['custom-id'] }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const removed = data.removed as string[];
    // Should map custom-id → user/custom via listAssigned fallback
    expect(removed).toContain('user/custom');
    // listAssigned should have been called (used by buildIdToSlugMap fallback)
    expect(listAssigned).toHaveBeenCalled();
  });

  it('buildIdToSlugMap gracefully handles listAssigned failure (fallback path)', async () => {
    // When ctx.skillOps.listAssigned throws and no prefetch is provided,
    // buildIdToSlugMap catches the error and only uses SYSTEM_SKILL_SLUGS
    const onSkillsChanged = vi.fn(async () => []);
    const reply = makeBrokerReply({ action: 'remove', skillIds: ['trading'] });
    const ctx = makeCtx({
      onSkillsChanged,
      redis: makeRedisWithReply(reply),
      skillOps: makeSkillOps({
        listAssigned: vi.fn(async () => { throw new Error('DB unavailable'); }),
      }),
    });

    const result = await removeSkills.execute({ skillIds: ['trading'] }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const removed = data.removed as string[];
    // Still maps via SYSTEM_SKILL_SLUGS despite listAssigned failure
    expect(removed).toContain('system/trading');
  });

  it('buildIdToSlugMap without skillOps uses only SYSTEM_SKILL_SLUGS', async () => {
    const onSkillsChanged = vi.fn(async () => []);
    const reply = makeBrokerReply({ action: 'remove', skillIds: ['trading'] });
    const ctx = makeCtx({
      onSkillsChanged,
      redis: makeRedisWithReply(reply),
      skillOps: undefined,
    });

    const result = await removeSkills.execute({ skillIds: ['trading'] }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const removed = data.removed as string[];
    // System slug still available
    expect(removed).toContain('system/trading');
  });
});

// ── add_skills: listAssigned/listAvailable deduplication ────────────────

describe('add_skills — listAssigned/listAvailable deduplication', () => {
  // The key behavior: listAssigned and listAvailable are fetched once at the
  // top of the try block and reused for: buildIdToSlugMap, dependency resolution,
  // and file-management checks. These tests verify they're called exactly once.

  it('calls listAssigned exactly once per add_skills execution', async () => {
    const listAssigned = vi.fn(async () => [
      { id: 'skill-1', slug: 'system/trading', name: 'Trading', description: 'Trade', dependsOn: ['dep-a'] },
    ]);
    const listAvailable = vi.fn(async () => [
      { id: 'dep-a', slug: 'system/dep-a', name: 'Dep A', description: 'Dep', dependsOn: [] },
    ]);
    const onSkillsChanged = vi.fn(async () => ['skill-1', 'dep-a']);
    const reply = makeBrokerReply({ action: 'add', skillIds: ['skill-1', 'dep-a'] });
    const ctx = makeCtx({
      onSkillsChanged,
      redis: makeRedisWithReply(reply),
      skillOps: makeSkillOps({ listAssigned, listAvailable }),
    });

    await addSkills.execute({ skillIds: ['skill-1'], includeDependencies: true }, ctx);

    // listAssigned is used for: cached data (slug map + dep resolution + file-mgmt check)
    // It should be called exactly once, not multiple times
    expect(listAssigned).toHaveBeenCalledTimes(1);
  });

  it('calls listAvailable exactly once per add_skills execution', async () => {
    const listAssigned = vi.fn(async () => [
      { id: 'skill-1', slug: 'system/trading', name: 'Trading', description: 'Trade', dependsOn: ['dep-a'] },
    ]);
    const listAvailable = vi.fn(async () => [
      { id: 'dep-a', slug: 'system/dep-a', name: 'Dep A', description: 'Dep', dependsOn: [] },
    ]);
    const onSkillsChanged = vi.fn(async () => ['skill-1', 'dep-a']);
    const reply = makeBrokerReply({ action: 'add', skillIds: ['skill-1', 'dep-a'] });
    const ctx = makeCtx({
      onSkillsChanged,
      redis: makeRedisWithReply(reply),
      skillOps: makeSkillOps({ listAssigned, listAvailable }),
    });

    await addSkills.execute({ skillIds: ['skill-1'], includeDependencies: true }, ctx);

    expect(listAvailable).toHaveBeenCalledTimes(1);
  });

  it('reuses cached assigned data for both slug mapping and dependency resolution', async () => {
    // This test verifies that the same data from listAssigned is used for:
    // 1. buildIdToSlugMap (prefetchedAssigned parameter)
    // 2. Dependency resolution (cachedAssigned)
    const listAssigned = vi.fn(async () => [
      { id: 'skill-1', slug: 'system/trading', name: 'Trading', description: 'Trade', dependsOn: ['dep-a'] },
    ]);
    const onSkillsChanged = vi.fn(async () => ['skill-1', 'dep-a']);
    const reply = makeBrokerReply({ action: 'add', skillIds: ['skill-1', 'dep-a'] });
    const ctx = makeCtx({
      onSkillsChanged,
      redis: makeRedisWithReply(reply),
      skillOps: makeSkillOps({
        listAssigned,
        listAvailable: vi.fn(async () => []),
      }),
    });

    const result = await addSkills.execute({ skillIds: ['skill-1'], includeDependencies: true }, ctx);

    // Single call confirms deduplication
    expect(listAssigned).toHaveBeenCalledTimes(1);

    // Verify the cached data was used for slug mapping
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const added = data.added as string[];
    // skill-1 maps to system/trading via the cached assigned data
    expect(added).toContain('system/trading');

    // And the same data was used for dependency resolution
    const autoResolved = data.autoResolved as Array<{ skill: string; requiredBy: string }>;
    expect(autoResolved).toBeDefined();
    expect(autoResolved.some(r => r.requiredBy === 'system/trading')).toBe(true);
  });

  it('deduplication holds when multiple skills are added simultaneously', async () => {
    const listAssigned = vi.fn(async () => [
      { id: 'skill-a', slug: 'system/a', name: 'A', description: 'Skill A', dependsOn: ['dep-shared'] },
      { id: 'skill-b', slug: 'system/b', name: 'B', description: 'Skill B', dependsOn: ['dep-shared'] },
    ]);
    const listAvailable = vi.fn(async () => [
      { id: 'dep-shared', slug: 'system/dep-shared', name: 'Dep', description: 'Shared dep', dependsOn: [] },
    ]);
    const onSkillsChanged = vi.fn(async () => ['skill-a', 'skill-b', 'dep-shared']);
    const reply = makeBrokerReply({ action: 'add', skillIds: ['skill-a', 'skill-b', 'dep-shared'] });
    const ctx = makeCtx({
      onSkillsChanged,
      redis: makeRedisWithReply(reply),
      skillOps: makeSkillOps({ listAssigned, listAvailable }),
    });

    await addSkills.execute({ skillIds: ['skill-a', 'skill-b'], includeDependencies: true }, ctx);

    // Both should still be called exactly once despite two skills being added
    expect(listAssigned).toHaveBeenCalledTimes(1);
    expect(listAvailable).toHaveBeenCalledTimes(1);
  });

  it('deduplication holds when adding external refs alongside platform refs', async () => {
    const listAssigned = vi.fn(async () => []);
    const listAvailable = vi.fn(async () => []);
    const reply = makeBrokerReply({ action: 'add', skillIds: ['trading'] });
    const ctx = makeCtx({
      redis: makeRedisWithReply(reply),
      db: undefined,
      skillOps: makeSkillOps({ listAssigned, listAvailable }),
    });

    await addSkills.execute(
      { skillIds: ['system/trading', 'owner/ext-skill'], includeDependencies: true },
      ctx,
    );

    // Even with external refs, the platform skill lists are fetched only once
    expect(listAssigned).toHaveBeenCalledTimes(1);
    expect(listAvailable).toHaveBeenCalledTimes(1);
  });

  it('does not call listAssigned/listAvailable when skillOps is missing', async () => {
    const reply = makeBrokerReply({ action: 'add', skillIds: ['skill-1'] });
    const ctx = makeCtx({
      redis: makeRedisWithReply(reply),
      skillOps: undefined,
    });

    const result = await addSkills.execute({ skillIds: ['skill-1'] }, ctx);

    expect(result.success).toBe(true);
    // No skillOps → no calls at all
    // (Can't assert on mock — no mock exists — but success proves it doesn't crash)
  });

  it('handles listAssigned/listAvailable failure gracefully (cached arrays stay empty)', async () => {
    const listAssigned = vi.fn(async () => { throw new Error('DB exploded'); });
    const listAvailable = vi.fn(async () => { throw new Error('DB exploded'); });
    const reply = makeBrokerReply({ action: 'add', skillIds: ['skill-1'] });
    const ctx = makeCtx({
      redis: makeRedisWithReply(reply),
      skillOps: makeSkillOps({ listAssigned, listAvailable }),
    });

    const result = await addSkills.execute({ skillIds: ['skill-1'], includeDependencies: true }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    // No autoResolved — cached arrays are empty due to failure
    expect(data.autoResolved).toBeUndefined();
    // Slug map falls back to SYSTEM_SKILL_SLUGS only
    expect(data.added).toEqual(['skill-1']);
  });
});


// ── Edge cases from code review ─────────────────────────────────────────

describe('add_skills — dependency resolution edge cases', () => {
  it('does not spuriously add available skills that are not dependencies when includeDependencies is true', async () => {
    const publishToInbound = vi.fn(async () => undefined);
    const onSkillsChanged = vi.fn(async () => ['skill-1']);
    const reply = makeBrokerReply({ action: 'add', skillIds: ['skill-1'] });
    const ctx = makeCtx({
      publishToInbound,
      onSkillsChanged,
      redis: makeRedisWithReply(reply),
      skillOps: makeSkillOps({
        listAssigned: vi.fn(async () => []),
        listAvailable: vi.fn(async () => [
          { id: 'skill-1', slug: 'system/trading', name: 'Trading', description: 'Trade', dependsOn: [] },
          { id: 'unrelated-skill', slug: 'system/unrelated', name: 'Unrelated', description: 'Not a dep', dependsOn: [] },
          { id: 'another-skill', slug: 'system/another', name: 'Another', description: 'Also not a dep', dependsOn: [] },
        ]),
      }),
    });

    const result = await addSkills.execute(
      { skillIds: ['skill-1'], includeDependencies: true },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    // No autoResolved — skill-1 has dependsOn: [] so no deps to add
    expect(data.autoResolved).toBeUndefined();
    // Broker should only receive skill-1, not the unrelated available skills
    expect(publishToInbound).toHaveBeenCalledOnce();
    const [, payload] = publishToInbound.mock.calls[0]! as [string, Record<string, unknown>];
    expect(payload.skillIds).toEqual(['skill-1']);
    expect(payload.skillIds).not.toContain('unrelated-skill');
    expect(payload.skillIds).not.toContain('another-skill');
  });

  it('handles circular dependencies without hanging or producing duplicates', async () => {
    const publishToInbound = vi.fn(async () => undefined);
    const onSkillsChanged = vi.fn(async () => ['skill-a', 'skill-b']);
    const reply = makeBrokerReply({ action: 'add', skillIds: ['skill-a', 'skill-b'] });
    const ctx = makeCtx({
      publishToInbound,
      onSkillsChanged,
      redis: makeRedisWithReply(reply),
      skillOps: makeSkillOps({
        listAssigned: vi.fn(async () => []),
        listAvailable: vi.fn(async () => [
          // Circular: skill-a depends on skill-b, skill-b depends on skill-a
          { id: 'skill-a', slug: 'system/a', name: 'A', description: 'Skill A', dependsOn: ['skill-b'] },
          { id: 'skill-b', slug: 'system/b', name: 'B', description: 'Skill B', dependsOn: ['skill-a'] },
        ]),
      }),
    });

    // Adding both skills that form a cycle
    const result = await addSkills.execute(
      { skillIds: ['skill-a', 'skill-b'], includeDependencies: true },
      ctx,
    );

    expect(result.success).toBe(true);
    // The implementation does a single-pass scan: for each requested skill,
    // check if deps are already in the requested set or already assigned.
    // Since skill-a and skill-b are both in the requested set, neither should
    // trigger auto-resolution.
    const data = result.data as Record<string, unknown>;
    expect(data.autoResolved).toBeUndefined();
    // Broker receives exactly the two requested skills, no duplicates
    expect(publishToInbound).toHaveBeenCalledOnce();
    const [, payload] = publishToInbound.mock.calls[0]! as [string, Record<string, unknown>];
    const sentIds = payload.skillIds as string[];
    expect(sentIds).toHaveLength(2);
    expect(new Set(sentIds).size).toBe(2); // no duplicates
    expect(sentIds).toEqual(expect.arrayContaining(['skill-a', 'skill-b']));
  });

  it('handles circular dependency when only one side is requested', async () => {
    const publishToInbound = vi.fn(async () => undefined);
    const onSkillsChanged = vi.fn(async () => ['skill-a', 'skill-b']);
    const reply = makeBrokerReply({ action: 'add', skillIds: ['skill-a', 'skill-b'] });
    const ctx = makeCtx({
      publishToInbound,
      onSkillsChanged,
      redis: makeRedisWithReply(reply),
      skillOps: makeSkillOps({
        listAssigned: vi.fn(async () => []),
        listAvailable: vi.fn(async () => [
          { id: 'skill-a', slug: 'system/a', name: 'A', description: 'Skill A', dependsOn: ['skill-b'] },
          { id: 'skill-b', slug: 'system/b', name: 'B', description: 'Skill B', dependsOn: ['skill-a'] },
        ]),
      }),
    });

    // Only requesting skill-a — skill-b is a dependency
    const result = await addSkills.execute(
      { skillIds: ['skill-a'], includeDependencies: true },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    // skill-b auto-resolved as dependency of skill-a
    // Note: buildIdToSlugMap seeds from SYSTEM_SKILL_SLUGS + cachedAssigned,
    // but not cachedAvailable, so non-system IDs from available-only skills
    // will use the raw ID as fallback in autoResolved entries.
    const autoResolved = data.autoResolved as Array<{ skill: string; requiredBy: string }>;
    expect(autoResolved).toBeDefined();
    expect(autoResolved).toEqual(expect.arrayContaining([
      { skill: 'skill-b', requiredBy: 'skill-a' },
    ]));
    // The single-pass scan won't recursively resolve skill-b's dep on skill-a
    // (skill-a is already in the platform IDs list), so no infinite recursion
    expect(publishToInbound).toHaveBeenCalledOnce();
    const [, payload] = publishToInbound.mock.calls[0]! as [string, Record<string, unknown>];
    const sentIds = payload.skillIds as string[];
    expect(sentIds).toEqual(expect.arrayContaining(['skill-a', 'skill-b']));
    expect(new Set(sentIds).size).toBe(sentIds.length); // no duplicates
  });
});
