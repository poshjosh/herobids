// activateExternalSkill is the one install-and-verify path for agent start,
// add_skills and read_skill. These tests pin each outcome with a fake installer,
// so no skills CLI runs and no restart is needed.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ExternalSkillInstaller } from '@herobids/domain';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activateExternalSkill } from './skills.js';

const REF = 'owner/repo/echo';
let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'hb-activation-'));
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

/** Installer that writes SKILL.md where the CLI would, with the given content. */
function writingInstaller(content: string): ExternalSkillInstaller {
  return {
    install: vi.fn(async (_ref: string, cwd: string) => {
      const dir = join(cwd, '.agents', 'skills', 'echo');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'SKILL.md'), content, 'utf-8');
      return { ok: true as const, output: 'Installed echo' };
    }),
  };
}

describe('activateExternalSkill', () => {
  it('is ready with the body, name and description from the installed SKILL.md', async () => {
    const installer = writingInstaller('---\nname: echo\ndescription: Echo skill.\n---\nBODY LINE\n');
    const result = await activateExternalSkill({ ref: REF, workspaceRoot, installer });

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.name).toBe('echo');
    expect(result.description).toBe('Echo skill.');
    expect(result.content).toContain('BODY LINE');
    expect(result.output).toBe('Installed echo');
  });

  it('falls back to the given name and description when the frontmatter omits them', async () => {
    const installer = writingInstaller('---\nname: echo\n---\nBODY\n');
    const result = await activateExternalSkill({
      ref: REF,
      workspaceRoot,
      installer,
      fallback: { name: 'stale-name', description: 'stale description' },
    });

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.name).toBe('echo');
    expect(result.description).toBe('stale description');
  });

  it('reports install_failed with the installer reason when the CLI fails', async () => {
    const installer: ExternalSkillInstaller = {
      install: async () => ({ ok: false as const, error: 'network down' }),
    };
    const result = await activateExternalSkill({ ref: REF, workspaceRoot, installer });

    expect(result).toEqual({ status: 'install_failed', reason: 'network down' });
  });

  it('reports install_failed when the CLI exits 0 but writes no SKILL.md', async () => {
    const installer: ExternalSkillInstaller = {
      install: async () => ({ ok: true as const, output: 'Done' }),
    };
    const result = await activateExternalSkill({ ref: REF, workspaceRoot, installer });

    expect(result.status).toBe('install_failed');
    if (result.status !== 'install_failed') return;
    expect(result.reason).toContain('was not written');
    expect(result.reason).toContain('Done');
  });

  it('never throws: an installer that throws becomes install_failed', async () => {
    const installer: ExternalSkillInstaller = {
      install: async () => {
        throw new Error('spawn exploded');
      },
    };
    const result = await activateExternalSkill({ ref: REF, workspaceRoot, installer });

    expect(result).toEqual({ status: 'install_failed', reason: 'External install unavailable: spawn exploded' });
  });
});
