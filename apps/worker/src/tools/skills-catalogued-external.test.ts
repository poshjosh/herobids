// add_skills must install a ref that is already catalogued as an external skill.
// Regression: the catalogue row for traderton/skills/crypto-trading exists, so the
// platform lookup matched it and assigned the row without running the installer,
// leaving SKILL.md missing. The real add tool and the fixture installer run here;
// only the DB lookups and the broker are stubbed, so no restart or live stack is needed.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ToolContext } from '@herobids/domain';
import { AGENT_MESSAGE_TYPES } from '@herobids/domain';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { externalSkillIdForRef, findExternalSourceRefs, resolveSkillIdsBySlugOrId } from '@herobids/db';
import { skillTools } from './skills.js';
import { LocalDirectorySkillInstaller } from './local-directory-skill-installer.js';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    throw new Error('skills CLI must not be spawned');
  }),
}));

// Only the catalogue lookups are stubbed; everything else in @herobids/db is real.
vi.mock('@herobids/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@herobids/db')>()),
  resolveSkillIdsBySlugOrId: vi.fn(async () => new Map<string, string>()),
  findExternalSourceRefs: vi.fn(async () => new Set<string>()),
  upsertExternalSkill: vi.fn(async (_db: unknown, input: { sourceRef: string }) => ({
    skillId: externalSkillIdForRef(input.sourceRef),
  })),
}));

const mockedSpawn = vi.mocked(spawn);
const mockedResolve = vi.mocked(resolveSkillIdsBySlugOrId);
const mockedFindExternal = vi.mocked(findExternalSourceRefs);

const REF = 'example/skills/echo';
const EXT_ID = externalSkillIdForRef(REF);
const FIXTURE_SOURCE_ROOT = fileURLToPath(new URL('./__fixtures__/external-skill-source/', import.meta.url));
const FIXTURE_SKILL_MD = join(FIXTURE_SOURCE_ROOT, 'example', 'skills', 'skills', 'echo', 'SKILL.md');

const addSkills = skillTools.find((t) => t.name === 'add_skills');
if (!addSkills) throw new Error('add_skills tool not registered');

let workspaceRoot: string;

function brokerRedis(skillIds: string[]): ToolContext['redis'] {
  return {
    hset: vi.fn(async () => 1),
    hget: vi.fn(async () => null),
    hgetall: vi.fn(async () => null),
    hdel: vi.fn(async () => 0),
    publish: vi.fn(async () => 0),
    blpop: vi.fn(async (): Promise<[string, string]> => [
      'key',
      JSON.stringify({ status: 'ok', action: 'add', skillIds, warnings: [] }),
    ]),
    smembers: vi.fn(async () => []),
    sadd: vi.fn(async () => 0),
    srem: vi.fn(async () => 0),
    expire: vi.fn(async () => 0),
  };
}

function makeCtx(overrides: Partial<ToolContext>): ToolContext {
  return {
    agentId: 'agent-1',
    sessionId: 'session-1',
    phase: 'scout',
    permissionLevel: 'standard',
    executionMode: 'paper',
    authorizationMode: 'direct',
    publishToInbound: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as ToolContext;
}

beforeEach(async () => {
  mockedSpawn.mockClear();
  mockedResolve.mockReset();
  mockedResolve.mockResolvedValue(new Map<string, string>());
  mockedFindExternal.mockReset();
  mockedFindExternal.mockResolvedValue(new Set<string>());
  workspaceRoot = await mkdtemp(join(tmpdir(), 'hb-catalogued-external-'));
  vi.stubEnv('AGENT_WORKSPACE_ROOT', workspaceRoot);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(workspaceRoot, { recursive: true, force: true });
});

describe('add_skills with a ref already catalogued as external', () => {
  it('runs the installer and assigns the external skill, not the bare catalogue row', async () => {
    // The catalogue already holds this ref, so the platform lookup matches it.
    mockedResolve.mockResolvedValue(new Map([[REF, EXT_ID]]));
    mockedFindExternal.mockResolvedValue(new Set([REF]));
    const publishToInbound = vi.fn(async () => undefined);
    const ctx = makeCtx({
      db: {} as never,
      publishToInbound,
      redis: brokerRedis([EXT_ID]),
      externalSkillInstaller: new LocalDirectorySkillInstaller({ sourceRoot: FIXTURE_SOURCE_ROOT }),
    });

    const result = await addSkills.execute({ skillIds: [REF], includeDependencies: false }, ctx);

    expect(result.success).toBe(true);
    // The install ran: SKILL.md is on disk where read_skill looks for it.
    const installed = await readFile(join(workspaceRoot, '.agents', 'skills', 'echo', 'SKILL.md'));
    const fixture = await readFile(FIXTURE_SKILL_MD);
    expect(installed.equals(fixture)).toBe(true);
    // The assignment went out for the external id, and the ref is reported as added.
    expect(publishToInbound).toHaveBeenCalledWith(
      AGENT_MESSAGE_TYPES.MANAGE_AGENT_SKILLS,
      expect.objectContaining({ action: 'add', skillIds: [EXT_ID] }),
    );
    expect((result.data as { added: string[] }).added).toContain(REF);
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it('keeps a user-authored platform slug on the platform path (no install)', async () => {
    const userSlug = 'alice/notes';
    const userSkillId = 'skill-uuid-1';
    mockedResolve.mockResolvedValue(new Map([[userSlug, userSkillId]]));
    mockedFindExternal.mockResolvedValue(new Set());
    const publishToInbound = vi.fn(async () => undefined);
    const installer = { install: vi.fn(async () => ({ ok: true as const, output: '' })) };
    const ctx = makeCtx({
      db: {} as never,
      publishToInbound,
      redis: brokerRedis([userSkillId]),
      externalSkillInstaller: installer,
    });

    const result = await addSkills.execute({ skillIds: [userSlug], includeDependencies: false }, ctx);

    expect(result.success).toBe(true);
    expect(installer.install).not.toHaveBeenCalled();
    expect(publishToInbound).toHaveBeenCalledWith(
      AGENT_MESSAGE_TYPES.MANAGE_AGENT_SKILLS,
      expect.objectContaining({ action: 'add', skillIds: [userSkillId] }),
    );
  });
});
