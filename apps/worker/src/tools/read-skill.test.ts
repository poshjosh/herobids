// Phase 4 T7 — read_skill loads an installed external skill's body from the
// workspace and marks it loaded for the session.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '@herobids/domain';
import { readSkillTool } from './read-skill.js';

const REF = 'traderton/skills/crypto-trading';
const SKILL_DIR = 'crypto-trading';

let workspaceRoot: string;
let agentId: string;

function makeSession(available = true) {
  const loaded = new Map<string, string>();
  return {
    assignedRefs: () => [REF],
    availabilityFor: () => ({ available, name: 'Crypto Trading', description: 'trade' }),
    markLoaded: (ref: string, body: string) => loaded.set(ref, body),
    isLoaded: (ref: string) => loaded.has(ref),
    _loaded: loaded,
  };
}

function makeCtx(
  session: ReturnType<typeof makeSession> | undefined,
  installer?: { install: ReturnType<typeof vi.fn> },
): ToolContext {
  return {
    agentId,
    externalSkillSession: session,
    externalSkillInstaller: installer,
  } as unknown as ToolContext;
}

/** Fake installer: optionally writes SKILL.md into the workspace, or fails. */
function fakeInstaller(options: { writeSkill: boolean; ok?: boolean; error?: string }) {
  const install = vi.fn(async (_ref: string, cwd: string) => {
    if (options.ok === false) return { ok: false as const, error: options.error ?? 'install failed' };
    if (options.writeSkill) {
      const dir = join(cwd, '.agents', 'skills', SKILL_DIR);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'SKILL.md'), '---\nname: crypto-trading\ndescription: trade\n---\nINSTALLED BODY\n', 'utf-8');
    }
    return { ok: true as const, output: 'Installed' };
  });
  return { install };
}

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'read-skill-'));
  agentId = 'agent-under-test';
  // read_skill resolves the workspace via getWorkspacePaths(agentId), which
  // honours AGENT_WORKSPACE_ROOT — point it at our temp dir.
  process.env['AGENT_WORKSPACE_ROOT'] = workspaceRoot;
  const dir = join(workspaceRoot, '.agents', 'skills', SKILL_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'SKILL.md'),
    '---\nname: crypto-trading\ndescription: trade\n---\nBODY LINE ONE\nBODY LINE TWO\n',
    'utf-8',
  );
});

afterEach(async () => {
  delete process.env['AGENT_WORKSPACE_ROOT'];
  await rm(workspaceRoot, { recursive: true, force: true });
});

describe('read_skill', () => {
  it('loads the installed SKILL.md body (frontmatter stripped) and marks it loaded', async () => {
    const session = makeSession(true);
    const result = await readSkillTool.execute({ ref: REF }, makeCtx(session));
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.loaded).toBe(true);
    expect(String(data.instructions)).toContain('BODY LINE ONE');
    expect(String(data.instructions)).not.toContain('name: crypto-trading');
    expect(session.isLoaded(REF)).toBe(true);
  });

  it('accepts the owner/repo@skill form as well as owner/repo/skill', async () => {
    const session = makeSession(true);
    const result = await readSkillTool.execute({ ref: 'traderton/skills@crypto-trading' }, makeCtx(session));
    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>).loaded).toBe(true);
  });

  it('rejects a ref not assigned to the agent', async () => {
    const session = makeSession(true);
    const result = await readSkillTool.execute({ ref: 'someone/else/skill' }, makeCtx(session));
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('skill.not_assigned');
  });

  it('reports temporarily unavailable when this session marked the install failed', async () => {
    const session = makeSession(false);
    const result = await readSkillTool.execute({ ref: REF }, makeCtx(session));
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.loaded).toBe(false);
    expect(data.available).toBe(false);
    expect(session.isLoaded(REF)).toBe(false);
  });

  it('reports not-installed when the body file is absent and the install fails', async () => {
    await rm(join(workspaceRoot, '.agents', 'skills', SKILL_DIR), { recursive: true, force: true });
    const session = makeSession(true);
    const installer = fakeInstaller({ writeSkill: false, ok: false, error: 'network down' });
    const result = await readSkillTool.execute({ ref: REF }, makeCtx(session, installer));
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.loaded).toBe(false);
    expect(String(data.message)).toContain('network down');
  });

  it('installs a missing assigned skill on read, then loads its body', async () => {
    await rm(join(workspaceRoot, '.agents', 'skills', SKILL_DIR), { recursive: true, force: true });
    const session = makeSession(true);
    const installer = fakeInstaller({ writeSkill: true });
    const result = await readSkillTool.execute({ ref: REF }, makeCtx(session, installer));
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.loaded).toBe(true);
    expect(String(data.instructions)).toContain('INSTALLED BODY');
    expect(installer.install).toHaveBeenCalledTimes(1);
    expect(session.isLoaded(REF)).toBe(true);
  });

  it('does not run the installer when the body is already present', async () => {
    const session = makeSession(true);
    const installer = fakeInstaller({ writeSkill: true });
    const result = await readSkillTool.execute({ ref: REF }, makeCtx(session, installer));
    expect((result.data as Record<string, unknown>).loaded).toBe(true);
    expect(installer.install).not.toHaveBeenCalled();
  });

  it('lists the tools visible for a loaded skill and names any tagged tool that was dropped', async () => {
    const base = makeSession(true);
    const session = {
      ...base,
      toolReportFor: () => ({
        outcome: 'tools_exposed',
        toolNames: ['get_price'],
        droppedTools: [{ name: 'ghost_tool', reason: 'not_in_local_registry' }],
      }),
    };
    const result = await readSkillTool.execute({ ref: REF }, makeCtx(session));
    const data = result.data as Record<string, unknown>;
    expect(data.loaded).toBe(true);
    expect(data.tools).toEqual(['get_price']);
    expect(data.droppedTools).toEqual([{ name: 'ghost_tool', reason: 'not_in_local_registry' }]);
    expect(String(data.toolNotice)).toContain('ghost_tool');
  });

  it('says the backend is unreachable when the skill was discovered as unreachable', async () => {
    const base = makeSession(true);
    const session = {
      ...base,
      toolReportFor: () => ({ outcome: 'backend_unreachable', toolNames: [], droppedTools: [] }),
    };
    const result = await readSkillTool.execute({ ref: REF }, makeCtx(session));
    const data = result.data as Record<string, unknown>;
    expect(data.loaded).toBe(true);
    expect(String(data.toolNotice)).toContain('backend unreachable');
  });

  it('reports not-written when the install exits 0 but produces no SKILL.md', async () => {
    await rm(join(workspaceRoot, '.agents', 'skills', SKILL_DIR), { recursive: true, force: true });
    const session = makeSession(true);
    const installer = fakeInstaller({ writeSkill: false });
    const result = await readSkillTool.execute({ ref: REF }, makeCtx(session, installer));
    const data = result.data as Record<string, unknown>;
    expect(data.loaded).toBe(false);
    expect(String(data.message)).toContain('was not written');
  });
});
