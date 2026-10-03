import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import type { ToolContext } from '@herobids/domain';
import { AGENT_MESSAGE_TYPES } from '@herobids/domain';
import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { skillTools } from './skills.js';
import { LocalDirectorySkillInstaller } from './local-directory-skill-installer.js';

// Any attempt to reach the real skills CLI fails loudly; the default-path test
// relies on the throw being reported as a graceful per-ref failure.
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    throw new Error('skills CLI must not be spawned');
  }),
}));

const mockedSpawn = vi.mocked(spawn);

const FIXTURE_SOURCE_ROOT = fileURLToPath(new URL('./__fixtures__/external-skill-source/', import.meta.url));
const FIXTURE_SKILLS_DIR = join(FIXTURE_SOURCE_ROOT, 'example', 'skills', 'skills');

const addSkills = skillTools.find((t) => t.name === 'add_skills');
if (!addSkills) throw new Error('add_skills tool not registered');

const AddSkillsDataSchema = z.object({
  added: z.array(z.string()),
  autoResolved: z.array(z.object({ skill: z.string(), requiredBy: z.string() })).optional(),
  warnings: z.array(z.string()).optional(),
  external: z.array(z.object({
    ref: z.string(),
    ok: z.boolean(),
    output: z.string().optional(),
    error: z.string().optional(),
  })).optional(),
});

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

/** Broker replies in call order: each call to blpop returns the next reply's skillIds. */
function makeRedisWithReplies(skillIdsPerCall: string[][]): ToolContext['redis'] {
  let call = 0;
  return makeRedisMock({
    blpop: vi.fn(async (): Promise<[string, string]> => {
      const skillIds = skillIdsPerCall[call] ?? [];
      call += 1;
      return ['key', JSON.stringify({ status: 'ok', action: 'add', skillIds, warnings: [] })];
    }),
  });
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    agentId: 'agent-1',
    sessionId: 'session-1',
    phase: 'scout',
    permissionLevel: 'standard',
    executionMode: 'paper',
    authorizationMode: 'direct',
    redis: makeRedisMock(),
    publishToInbound: vi.fn(async () => undefined),
    ...overrides,
  };
}

function makeFixtureInstaller(): LocalDirectorySkillInstaller {
  return new LocalDirectorySkillInstaller({ sourceRoot: FIXTURE_SOURCE_ROOT });
}

describe('add_skills with a local fixture skill source', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    mockedSpawn.mockClear();
    workspaceRoot = await mkdtemp(join(tmpdir(), 'hb-skills-local-source-'));
    vi.stubEnv('AGENT_WORKSPACE_ROOT', workspaceRoot);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it('installs example/skills/echo end-to-end from the fixture source without spawning the CLI', async () => {
    const publishToInbound = vi.fn(async () => undefined);
    const ctx = makeCtx({ publishToInbound, externalSkillInstaller: makeFixtureInstaller() });

    const result = await addSkills.execute({ skillIds: ['example/skills/echo'], includeDependencies: false }, ctx);

    expect(result.success).toBe(true);
    const data = AddSkillsDataSchema.parse(result.data);
    expect(data.added).toContain('example/skills/echo');
    expect(data.external).toEqual([{ ref: 'example/skills/echo', ok: true, output: 'Installed echo from local source' }]);

    const installed = await readFile(join(workspaceRoot, '.agents', 'skills', 'echo', 'SKILL.md'));
    const fixture = await readFile(join(FIXTURE_SKILLS_DIR, 'echo', 'SKILL.md'));
    expect(installed.equals(fixture)).toBe(true);
    expect(mockedSpawn).not.toHaveBeenCalled();
    expect(publishToInbound).not.toHaveBeenCalled();
  });

  it('feeds the installed SKILL.md to the post-install Bash detection', async () => {
    const publishToInbound = vi.fn(async () => undefined);
    const ctx = makeCtx({
      publishToInbound,
      redis: makeRedisWithReplies([['file-management'], ['programming']]),
      externalSkillInstaller: makeFixtureInstaller(),
    });

    const result = await addSkills.execute({ skillIds: ['example/skills/echo-shell'] }, ctx);

    expect(result.success).toBe(true);
    const data = AddSkillsDataSchema.parse(result.data);
    expect(data.external).toEqual([expect.objectContaining({ ref: 'example/skills/echo-shell', ok: true })]);
    expect(data.autoResolved).toEqual(expect.arrayContaining([
      { skill: 'system/programming', requiredBy: 'example/skills/echo-shell' },
    ]));
    expect(publishToInbound).toHaveBeenCalledWith(
      AGENT_MESSAGE_TYPES.MANAGE_AGENT_SKILLS,
      expect.objectContaining({ action: 'add', skillIds: ['programming'] }),
    );
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it('reports a typed failure for a ref absent from the local source', async () => {
    const ctx = makeCtx({ externalSkillInstaller: makeFixtureInstaller() });

    const result = await addSkills.execute({ skillIds: ['example/skills/missing'], includeDependencies: false }, ctx);

    expect(result.success).toBe(true);
    const data = AddSkillsDataSchema.parse(result.data);
    expect(data.added).toEqual([]);
    expect(data.external).toEqual([
      { ref: 'example/skills/missing', ok: false, error: 'skill not found in local source: example/skills@missing' },
    ]);
    expect(data.warnings).toEqual([expect.stringContaining('not found')]);
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it.each([
    '../x@y',
    'example/..@echo',
    'example/skills@..',
    'example/skills@../../etc',
    'example/skills/echo',
  ])('rejects the unsafe or non-normalized ref %s without writing to the workspace', async (ref) => {
    const result = await makeFixtureInstaller().install(ref, workspaceRoot);

    expect(result).toEqual({ ok: false, error: `unsupported external skill ref: ${ref}` });
    expect(await readdir(workspaceRoot)).toEqual([]);
  });

  describe('LocalDirectorySkillInstaller against a temporary source tree', () => {
    let sourceRoot: string;
    let skillDir: string;

    beforeEach(async () => {
      sourceRoot = await mkdtemp(join(tmpdir(), 'hb-skills-local-src-'));
      skillDir = join(sourceRoot, 'acme', 'skills', 'skills', 'demo');
      await mkdir(skillDir, { recursive: true });
    });

    afterEach(async () => {
      await rm(sourceRoot, { recursive: true, force: true });
    });

    it('copies symlinked files as regular files and skips the entries the CLI skips', async () => {
      await writeFile(join(skillDir, 'SKILL.md'), '---\nname: demo\ndescription: Demo skill.\n---\n# Demo\n');
      const outside = join(sourceRoot, 'outside.txt');
      await writeFile(outside, 'outside content');
      await symlink(outside, join(skillDir, 'linked.txt'));
      await writeFile(join(skillDir, 'metadata.json'), '{}');
      await mkdir(join(skillDir, '.git'));

      const result = await new LocalDirectorySkillInstaller({ sourceRoot }).install('acme/skills@demo', workspaceRoot);

      expect(result).toEqual({ ok: true, output: 'Installed demo from local source' });
      const installedDir = join(workspaceRoot, '.agents', 'skills', 'demo');
      const linked = await lstat(join(installedDir, 'linked.txt'));
      expect(linked.isSymbolicLink()).toBe(false);
      expect(await readFile(join(installedDir, 'linked.txt'), 'utf-8')).toBe('outside content');
      expect((await readdir(installedDir)).sort()).toEqual(['SKILL.md', 'linked.txt']);
    });

    it('replaces an existing install instead of merging into it', async () => {
      await writeFile(join(skillDir, 'SKILL.md'), '---\nname: demo\ndescription: Demo skill.\n---\n');
      const installedDir = join(workspaceRoot, '.agents', 'skills', 'demo');
      await mkdir(installedDir, { recursive: true });
      await writeFile(join(installedDir, 'stale.txt'), 'stale');

      const result = await new LocalDirectorySkillInstaller({ sourceRoot }).install('acme/skills@demo', workspaceRoot);

      expect(result.ok).toBe(true);
      expect(await readdir(installedDir)).toEqual(['SKILL.md']);
    });

    it.each([
      ['name', '---\ndescription: Demo skill.\n---\n'],
      ['description', '---\nname: demo\n---\n'],
    ])('rejects a SKILL.md without %s frontmatter and installs nothing', async (_missing, content) => {
      await writeFile(join(skillDir, 'SKILL.md'), content);

      const result = await new LocalDirectorySkillInstaller({ sourceRoot }).install('acme/skills@demo', workspaceRoot);

      expect(result).toEqual({
        ok: false,
        error: 'SKILL.md for acme/skills@demo must declare name and description frontmatter',
      });
      expect(await readdir(workspaceRoot)).toEqual([]);
    });
  });

  it('without an injected installer, keeps spawning `npx skills add <owner/repo@skill> --yes`', async () => {
    const ctx = makeCtx();

    const result = await addSkills.execute({ skillIds: ['example/skills/echo'], includeDependencies: false }, ctx);

    expect(mockedSpawn).toHaveBeenCalledTimes(1);
    expect(mockedSpawn).toHaveBeenCalledWith(
      'npx',
      ['skills', 'add', 'example/skills@echo', '--yes'],
      expect.objectContaining({ cwd: workspaceRoot, timeout: 30_000, env: expect.objectContaining({ CI: '1' }) }),
    );
    expect(result.success).toBe(true);
    const data = AddSkillsDataSchema.parse(result.data);
    expect(data.external).toEqual([
      {
        ref: 'example/skills/echo',
        ok: false,
        error: 'External install unavailable: skills CLI must not be spawned',
      },
    ]);
  });
});
