import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext, ExternalSkillProvider, ExternalSkillPage } from '@herobids/domain';
import { AGENT_MESSAGE_TYPES } from '@herobids/domain';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { parseSkillFrontmatter, detectExternalSkillBashDependency } from './skills.js';

// ── Module-level mocks (scoped to this file only) ───────────────────────────

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('./workspace.js', () => ({
  getWorkspacePaths: (_agentId: string) => ({ root: '/mock-workspace' }),
}));

const mockedReadFile = vi.mocked(readFile);
const mockedSpawn = vi.mocked(spawn);

// ── Shared test helpers (mirrors from skills.test.ts) ───────────────────────

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

/** Create a fake ChildProcess that emits `close` with exit code 0 after stdout drains. */
function fakeSpawnSuccess(stdoutData: string): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.stdout = new Readable({ read() { this.push(stdoutData); this.push(null); } });
  child.stderr = new Readable({ read() { this.push(null); } });
  (child as unknown as { stdin: null }).stdin = null;
  (child as unknown as { pid: number }).pid = 12345;
  setTimeout(() => child.emit('close', 0), 10);
  return child;
}

// ── Lazy tool import (after mocks are applied) ──────────────────────────────

// The `skillTools` import must happen after vi.mock calls are hoisted, so the
// tools see the mocked `spawn`, `readFile`, and `workspace.js`.
const { skillTools } = await import('./skills.js');
const addSkills = skillTools.find((t) => t.name === 'add_skills')!;

// ═══════════════════════════════════════════════════════════════════════════
// parseSkillFrontmatter — unit tests
// ═══════════════════════════════════════════════════════════════════════════

describe('parseSkillFrontmatter', () => {
  it('parses valid frontmatter with allowed-tools key', () => {
    const content = `---\nallowed-tools: Bash(agent-browser:*)\n---\n# My Skill`;
    const result = parseSkillFrontmatter(content);
    expect(result['allowed-tools']).toBe('Bash(agent-browser:*)');
  });

  it('returns empty object when no frontmatter delimiters exist', () => {
    const content = `# My Skill\n\nJust a regular markdown file.`;
    const result = parseSkillFrontmatter(content);
    expect(result).toEqual({});
  });

  it('returns empty object for empty frontmatter (just delimiters)', () => {
    const content = `---\n---\n# My Skill`;
    const result = parseSkillFrontmatter(content);
    expect(result).toEqual({});
  });

  it('parses multiple key-value pairs correctly', () => {
    const content = `---\nname: My Skill\nallowed-tools: Bash(agent-browser:*)\nversion: 1.0\n---\n# Content`;
    const result = parseSkillFrontmatter(content);
    expect(result['name']).toBe('My Skill');
    expect(result['allowed-tools']).toBe('Bash(agent-browser:*)');
    expect(result['version']).toBe('1.0');
  });

  it('handles values with colons correctly (takes everything after first colon)', () => {
    const content = `---\nallowed-tools: Bash(agent-browser:*), Read(file:txt)\n---\n# Content`;
    const result = parseSkillFrontmatter(content);
    expect(result['allowed-tools']).toBe('Bash(agent-browser:*), Read(file:txt)');
  });

  it('ignores lines without a colon', () => {
    const content = `---\nallowed-tools: Bash(cmd)\njust-a-line-without-value\n---`;
    const result = parseSkillFrontmatter(content);
    expect(result['allowed-tools']).toBe('Bash(cmd)');
    expect(Object.keys(result)).toHaveLength(1);
  });

  it('trims whitespace around keys and values', () => {
    const content = `---\n  allowed-tools :  Bash(cmd)  \n---`;
    const result = parseSkillFrontmatter(content);
    expect(result['allowed-tools']).toBe('Bash(cmd)');
  });

  it('parses frontmatter with CRLF line endings', () => {
    const content = `---\r\nallowed-tools: Bash(agent-browser:*)\r\nname: My Skill\r\n---\r\n# Content`;
    const result = parseSkillFrontmatter(content);
    expect(result['allowed-tools']).toBe('Bash(agent-browser:*)');
    expect(result['name']).toBe('My Skill');
  });

  it('parses frontmatter with mixed LF and CRLF line endings', () => {
    const content = `---\r\nallowed-tools: Bash(cmd)\nname: Mixed\r\n---\n# Content`;
    const result = parseSkillFrontmatter(content);
    expect(result['allowed-tools']).toBe('Bash(cmd)');
    expect(result['name']).toBe('Mixed');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// detectExternalSkillBashDependency — unit tests (mocked readFile)
// ═══════════════════════════════════════════════════════════════════════════

describe('detectExternalSkillBashDependency', () => {
  beforeEach(() => {
    mockedReadFile.mockReset();
  });

  it('returns the matching ref when SKILL.md has allowed-tools containing Bash(', async () => {
    mockedReadFile.mockResolvedValueOnce(
      `---\nallowed-tools: Bash(agent-browser:*)\n---\n# Skill content`,
    );

    const result = await detectExternalSkillBashDependency('/workspace', ['owner/repo@my-skill']);

    expect(result).toBe('owner/repo@my-skill');
    expect(mockedReadFile).toHaveBeenCalledWith(
      '/workspace/.agents/skills/my-skill/SKILL.md',
      'utf-8',
    );
  });

  it('returns null when SKILL.md has no allowed-tools key', async () => {
    mockedReadFile.mockResolvedValueOnce(
      `---\nname: My Skill\n---\n# Skill content`,
    );

    const result = await detectExternalSkillBashDependency('/workspace', ['owner/repo@my-skill']);

    expect(result).toBeNull();
  });

  it('returns null when allowed-tools does not contain Bash(', async () => {
    mockedReadFile.mockResolvedValueOnce(
      `---\nallowed-tools: Read(file:*), Write(file:*)\n---\n# Skill content`,
    );

    const result = await detectExternalSkillBashDependency('/workspace', ['owner/repo@my-skill']);

    expect(result).toBeNull();
  });

  it('returns null gracefully when SKILL.md cannot be read', async () => {
    mockedReadFile.mockRejectedValueOnce(new Error('ENOENT: no such file or directory'));

    const result = await detectExternalSkillBashDependency('/workspace', ['owner/repo@my-skill']);

    expect(result).toBeNull();
  });

  it('returns the first matching ref when multiple refs are provided', async () => {
    mockedReadFile.mockResolvedValueOnce(
      `---\nallowed-tools: Read(file:*)\n---\n# Skill A`,
    );
    mockedReadFile.mockResolvedValueOnce(
      `---\nallowed-tools: Bash(run:*)\n---\n# Skill B`,
    );

    const result = await detectExternalSkillBashDependency('/workspace', [
      'owner/repo@skill-a',
      'owner/repo@skill-b',
    ]);

    expect(result).toBe('owner/repo@skill-b');
  });

  it('returns null when no refs have Bash dependency', async () => {
    mockedReadFile.mockResolvedValueOnce(`---\nallowed-tools: Read(file:*)\n---`);
    mockedReadFile.mockResolvedValueOnce(`---\nname: Other\n---`);

    const result = await detectExternalSkillBashDependency('/workspace', [
      'owner/repo@skill-a',
      'owner/repo@skill-b',
    ]);

    expect(result).toBeNull();
  });

  it('derives correct directory for owner/repo@skill format', async () => {
    mockedReadFile.mockResolvedValueOnce(`# No frontmatter`);

    await detectExternalSkillBashDependency('/workspace', ['acme/tools@crypto-trader']);

    expect(mockedReadFile).toHaveBeenCalledWith(
      '/workspace/.agents/skills/crypto-trader/SKILL.md',
      'utf-8',
    );
  });

  it('derives correct directory for owner/repo/skill format (pre-normalization)', async () => {
    mockedReadFile.mockResolvedValueOnce(`# No frontmatter`);

    await detectExternalSkillBashDependency('/workspace', ['acme/tools/crypto-trader']);

    expect(mockedReadFile).toHaveBeenCalledWith(
      '/workspace/.agents/skills/crypto-trader/SKILL.md',
      'utf-8',
    );
  });

  it('returns null for an empty installedRefs array', async () => {
    const result = await detectExternalSkillBashDependency('/workspace', []);

    expect(result).toBeNull();
    expect(mockedReadFile).not.toHaveBeenCalled();
  });

  it('continues checking remaining refs when earlier ones fail to read', async () => {
    mockedReadFile.mockRejectedValueOnce(new Error('ENOENT'));
    mockedReadFile.mockResolvedValueOnce(
      `---\nallowed-tools: Bash(run:*)\n---\n# Skill B`,
    );

    const result = await detectExternalSkillBashDependency('/workspace', [
      'owner/repo@missing-skill',
      'owner/repo@bash-skill',
    ]);

    expect(result).toBe('owner/repo@bash-skill');
    expect(mockedReadFile).toHaveBeenCalledTimes(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// add_skills — auto-resolve system/programming for external Bash skills
//
// These tests mock spawn (for external install subprocess) and readFile
// (for SKILL.md reading) to exercise the full auto-resolve path.
// ═══════════════════════════════════════════════════════════════════════════

describe('add_skills — auto-resolve system/programming', () => {
  beforeEach(() => {
    mockedReadFile.mockReset();
    mockedSpawn.mockReset();
  });

  it('auto-resolves system/programming when external skill has Bash frontmatter', async () => {
    mockedSpawn.mockReturnValueOnce(fakeSpawnSuccess('Installed owner/repo@bash-skill\n'));

    // After install succeeds, detectExternalSkillBashDependency reads SKILL.md
    mockedReadFile.mockResolvedValueOnce(
      `---\nallowed-tools: Bash(agent-browser:*)\n---\n# Bash Skill`,
    );

    // Two broker calls: first for file-management, second for programming
    const publishToInbound = vi.fn(async () => undefined);
    let brokerCallCount = 0;
    const redis = makeRedisMock({
      blpop: vi.fn(async () => {
        brokerCallCount++;
        if (brokerCallCount === 1) {
          return ['key', JSON.stringify(makeBrokerReply({ action: 'add', skillIds: ['file-management'] }))];
        }
        return ['key', JSON.stringify(makeBrokerReply({ action: 'add', skillIds: ['programming'] }))];
      }),
    });

    const ctx = makeCtx({
      publishToInbound,
      redis,
      db: undefined,
      skillOps: makeSkillOps({
        listAssigned: vi.fn(async () => []),
        listAvailable: vi.fn(async () => []),
      }),
    });

    const result = await addSkills.execute(
      { skillIds: ['owner/repo@bash-skill'], includeDependencies: true },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const autoResolved = data.autoResolved as Array<{ skill: string; requiredBy: string }>;
    expect(autoResolved).toBeDefined();
    expect(autoResolved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ skill: 'system/programming', requiredBy: 'owner/repo@bash-skill' }),
      ]),
    );
  });

  it('does NOT auto-resolve system/programming when external skill lacks Bash frontmatter', async () => {
    mockedSpawn.mockReturnValueOnce(fakeSpawnSuccess('Installed owner/repo@no-bash-skill\n'));

    mockedReadFile.mockResolvedValueOnce(
      `---\nallowed-tools: Read(file:*)\n---\n# Non-Bash Skill`,
    );

    const publishToInbound = vi.fn(async () => undefined);
    const redis = makeRedisWithReply(makeBrokerReply({ action: 'add', skillIds: ['file-management'] }));

    const ctx = makeCtx({
      publishToInbound,
      redis,
      db: undefined,
      skillOps: makeSkillOps({
        listAssigned: vi.fn(async () => []),
        listAvailable: vi.fn(async () => []),
      }),
    });

    const result = await addSkills.execute(
      { skillIds: ['owner/repo@no-bash-skill'], includeDependencies: true },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const autoResolved = data.autoResolved as Array<{ skill: string; requiredBy: string }> | undefined;
    if (autoResolved) {
      expect(autoResolved.every(r => r.skill !== 'system/programming')).toBe(true);
    }
  });

  it('does NOT auto-resolve system/programming when programming is already assigned', async () => {
    mockedSpawn.mockReturnValueOnce(fakeSpawnSuccess('Installed owner/repo@bash-skill\n'));

    // Programming is already assigned — the code won't call
    // detectExternalSkillBashDependency, so no readFile mock needed.

    const publishToInbound = vi.fn(async () => undefined);
    const redis = makeRedisWithReply(makeBrokerReply({ action: 'add', skillIds: ['file-management'] }));

    const ctx = makeCtx({
      publishToInbound,
      redis,
      db: undefined,
      skillOps: makeSkillOps({
        listAssigned: vi.fn(async () => [
          { id: 'programming', slug: 'system/programming', name: 'Programming', description: 'Code', dependsOn: [] },
        ]),
        listAvailable: vi.fn(async () => []),
      }),
    });

    const result = await addSkills.execute(
      { skillIds: ['owner/repo@bash-skill'], includeDependencies: true },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const autoResolved = data.autoResolved as Array<{ skill: string; requiredBy: string }> | undefined;
    if (autoResolved) {
      expect(autoResolved.every(r => r.skill !== 'system/programming')).toBe(true);
    }
  });

  it('does NOT auto-resolve any dependencies when includeDependencies is false', async () => {
    mockedSpawn.mockReturnValueOnce(fakeSpawnSuccess('Installed owner/repo@bash-skill\n'));

    const publishToInbound = vi.fn(async () => undefined);
    const redis = makeRedisWithReply(makeBrokerReply({ action: 'add', skillIds: [] }));

    const ctx = makeCtx({
      publishToInbound,
      redis,
      db: undefined,
      skillOps: makeSkillOps({
        listAssigned: vi.fn(async () => []),
        listAvailable: vi.fn(async () => []),
      }),
    });

    const result = await addSkills.execute(
      { skillIds: ['owner/repo@bash-skill'], includeDependencies: false },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.autoResolved).toBeUndefined();
    // readFile should NOT have been called for Bash detection
    expect(mockedReadFile).not.toHaveBeenCalled();
  });
});
