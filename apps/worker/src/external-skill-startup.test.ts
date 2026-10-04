// Phase 4 T5/T11 (EC-6/EC-7) — install external skills at agent start, refresh
// metadata from frontmatter, and read the installed body back (progressive
// disclosure). Uses the LocalDirectorySkillInstaller fixture (an ExternalSkill
// Installer) against a temporary source tree — the same seam the real `npx
// skills` CLI plugs into — so a committed-edit-then-reinstall is exercised
// without the network.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalDirectorySkillInstaller } from './tools/local-directory-skill-installer.js';
import { installExternalSkillsAtStart, readInstalledSkillBody } from './external-skill-startup.js';
import type { ExternalSkillInstaller } from '@herobids/domain';

const REF = 'example/skills/echo';

let sourceRoot: string;
let workspaceRoot: string;
let skillMdPath: string;

async function writeSource(bodyLine: string): Promise<void> {
  const dir = join(sourceRoot, 'example', 'skills', 'skills', 'echo');
  await mkdir(dir, { recursive: true });
  skillMdPath = join(dir, 'SKILL.md');
  await writeFile(skillMdPath, `---\nname: echo\ndescription: Echo skill.\n---\n${bodyLine}\n`, 'utf-8');
}

beforeEach(async () => {
  sourceRoot = await mkdtemp(join(tmpdir(), 'hb-ess-src-'));
  workspaceRoot = await mkdtemp(join(tmpdir(), 'hb-ess-ws-'));
  await writeSource('ORIGINAL BODY LINE');
});

afterEach(async () => {
  await rm(sourceRoot, { recursive: true, force: true });
  await rm(workspaceRoot, { recursive: true, force: true });
});

function installer(): ExternalSkillInstaller {
  return new LocalDirectorySkillInstaller({ sourceRoot });
}

describe('installExternalSkillsAtStart', () => {
  it('installs an assigned external skill, refreshes name/description from frontmatter, and read_skill-reads the body', async () => {
    const availability = await installExternalSkillsAtStart({
      externalSkills: [{ id: 'ext', name: 'stale', description: 'stale', sourceRef: REF }],
      workspaceRoot,
      installer: installer(),
    });
    const state = availability.get(REF);
    expect(state?.available).toBe(true);
    expect(state?.name).toBe('echo');
    expect(state?.description).toBe('Echo skill.');

    const body = await readInstalledSkillBody(workspaceRoot, REF);
    expect(body).toContain('ORIGINAL BODY LINE');
    expect(body).not.toContain('name: echo'); // frontmatter stripped
  });

  it('picks up a committed SKILL.md edit on reinstall (EC-7 dependency proof)', async () => {
    await installExternalSkillsAtStart({
      externalSkills: [{ id: 'ext', name: 'echo', description: 'd', sourceRef: REF }],
      workspaceRoot,
      installer: installer(),
    });
    expect(await readInstalledSkillBody(workspaceRoot, REF)).toContain('ORIGINAL BODY LINE');

    // Edit the source (as a skill-repo push would) and restart the install loop.
    await writeSource('EDITED BODY LINE');
    await installExternalSkillsAtStart({
      externalSkills: [{ id: 'ext', name: 'echo', description: 'd', sourceRef: REF }],
      workspaceRoot,
      installer: installer(),
    });
    const body = await readInstalledSkillBody(workspaceRoot, REF);
    expect(body).toContain('EDITED BODY LINE');
    expect(body).not.toContain('ORIGINAL BODY LINE');
  });

  it('marks the skill unavailable (never throws) when the source is unreachable', async () => {
    const availability = await installExternalSkillsAtStart({
      externalSkills: [{ id: 'ext', name: 'echo', description: 'd', sourceRef: 'example/skills/missing' }],
      workspaceRoot,
      installer: installer(),
    });
    const state = availability.get('example/skills/missing');
    expect(state?.available).toBe(false);
    expect(state?.unavailableReason).toBeTruthy();
    // read_skill then finds nothing installed → null (reported as unavailable).
    expect(await readInstalledSkillBody(workspaceRoot, 'example/skills/missing')).toBeNull();
  });
});
