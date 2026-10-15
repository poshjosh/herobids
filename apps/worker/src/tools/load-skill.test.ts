// load_skill composes add_skills and read_skill: it adds an unassigned external
// skill, skips the add when already assigned, and loads the body either way.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext, ToolResult } from '@herobids/domain';

vi.mock('./skills.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./skills.js')>()),
  addSkillsTool: { execute: vi.fn() },
}));

import { addSkillsTool } from './skills.js';
import { loadSkillTool } from './load-skill.js';

const REF = 'traderton/skills/crypto-trading';
const SKILL_DIR = 'crypto-trading';

let workspaceRoot: string;
let assigned: string[];
const addExecute = vi.mocked(addSkillsTool.execute);

function makeCtx(): ToolContext {
  const loaded = new Map<string, string>();
  return {
    agentId: 'agent-under-test',
    externalSkillSession: {
      assignedRefs: () => [...assigned],
      availabilityFor: () => undefined,
      markLoaded: (ref: string, body: string) => loaded.set(ref, body),
      isLoaded: (ref: string) => loaded.has(ref),
    },
  } as unknown as ToolContext;
}

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'load-skill-'));
  assigned = [];
  addExecute.mockReset();
  addExecute.mockResolvedValue({ success: true, data: { added: [REF] } } as ToolResult);
  process.env['AGENT_WORKSPACE_ROOT'] = workspaceRoot;
  const dir = join(workspaceRoot, '.agents', 'skills', SKILL_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'SKILL.md'),
    '---\nname: crypto-trading\ndescription: trade\n---\nBODY LINE ONE\n',
    'utf-8',
  );
});

afterEach(async () => {
  delete process.env['AGENT_WORKSPACE_ROOT'];
  await rm(workspaceRoot, { recursive: true, force: true });
});

describe('load_skill', () => {
  it('adds an unassigned external skill and loads its body in one call', async () => {
    // add_skills hot-reloads the assignment into the session; simulate that.
    addExecute.mockImplementationOnce(async () => {
      assigned.push(REF);
      return { success: true, data: { added: [REF] } } as ToolResult;
    });
    const result = await loadSkillTool.execute({ ref: REF }, makeCtx());
    expect(result.success).toBe(true);
    expect(addExecute).toHaveBeenCalledWith({ skillIds: [REF] }, expect.anything());
    const data = result.data as Record<string, unknown>;
    expect(data.loaded).toBe(true);
    expect(data.added).toBe(true);
    expect(String(data.instructions)).toContain('BODY LINE ONE');
  });

  it('skips the add when the skill is already assigned and only loads the body', async () => {
    assigned = [REF];
    const result = await loadSkillTool.execute({ ref: REF }, makeCtx());
    expect(result.success).toBe(true);
    expect(addExecute).not.toHaveBeenCalled();
    const data = result.data as Record<string, unknown>;
    expect(data.loaded).toBe(true);
    expect(data.added).toBe(false);
  });

  it('returns the add_skills failure without attempting to read', async () => {
    addExecute.mockResolvedValue({ success: false, error: 'boom', errorCode: 'skill.mutation_failed' });
    const result = await loadSkillTool.execute({ ref: REF }, makeCtx());
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('skill.mutation_failed');
  });

  it('reports activation pending when the add succeeded but the assignment is not live yet', async () => {
    // add succeeds but hot-reload has not updated the session's assigned refs
    const result = await loadSkillTool.execute({ ref: REF }, makeCtx());
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.errorCode).toBe('skill.activation_pending');
  });

  it('rejects a platform skill slug, since load_skill is for external skills only', async () => {
    const result = await loadSkillTool.execute({ ref: 'system/programming' }, makeCtx());
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('validation.invalid_params');
    expect(addExecute).not.toHaveBeenCalled();
  });
});
