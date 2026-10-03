// Installs external skills from a local directory instead of the remote the
// `npx skills` CLI resolves. NOT wired in production: used by tests and by
// Phase 3 T4.3, because work kept local (D20) is invisible to the live CLI.
//
// Source layout mirrors the skill repos (openaidom-skills, traderton-skills):
//   <sourceRoot>/<owner>/<repo>/skills/<skill>/SKILL.md
// It models only the CLI's canonical-dir copy into
// `<workspaceRoot>/.agents/skills/<sanitized frontmatter name>/` — no agent
// symlinks, no remote discovery. Frontmatter is read with the existing
// line-based `parseSkillFrontmatter`, so SKILL.md must use single-line
// `name:` / `description:` values (the T4.1 authoring rule).

import type { ExternalSkillInstaller, ExternalSkillInstallResult } from '@herobids/domain';
import { cp, readFile, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parseSkillFrontmatter } from './skills.js';

const REF_PATTERN = /^([^/@]+)\/([^/@]+)@([^/@]+)$/;
const SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;
/** Entries the skills CLI (skills@1.5.25) skips when copying a skill. */
const EXCLUDED_ENTRIES = new Set(['.git', '__pycache__', '__pypackages__', 'metadata.json']);

export interface LocalDirectorySkillInstallerOptions {
  sourceRoot: string;
}

/** Parse `owner/repo@skill`; every segment must be a plain name (no traversal). */
function parseRef(ref: string): { owner: string; repo: string; skill: string } | null {
  const match = REF_PATTERN.exec(ref);
  if (!match) return null;
  const [, owner, repo, skill] = match;
  if (owner === undefined || repo === undefined || skill === undefined) return null;
  const isSafe = (segment: string) => SEGMENT_PATTERN.test(segment) && segment !== '.' && segment !== '..';
  return isSafe(owner) && isSafe(repo) && isSafe(skill) ? { owner, repo, skill } : null;
}

/** Same rule as the skills CLI `sanitizeName` (skills@1.5.25), which names the install dir. */
function sanitizeSkillDirName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .substring(0, 255) || 'unnamed-skill';
}

export class LocalDirectorySkillInstaller implements ExternalSkillInstaller {
  private readonly sourceRoot: string;

  constructor(options: LocalDirectorySkillInstallerOptions) {
    this.sourceRoot = options.sourceRoot;
  }

  async install(ref: string, workspaceRoot: string): Promise<ExternalSkillInstallResult> {
    const parsed = parseRef(ref);
    if (!parsed) {
      return { ok: false, error: `unsupported external skill ref: ${ref}` };
    }

    const sourceDir = join(this.sourceRoot, parsed.owner, parsed.repo, 'skills', parsed.skill);
    let content: string;
    try {
      content = await readFile(join(sourceDir, 'SKILL.md'), 'utf-8');
    } catch (err) {
      const code = err instanceof Error && 'code' in err ? err.code : undefined;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return { ok: false, error: `skill not found in local source: ${ref}` };
      }
      return { ok: false, error: `could not read SKILL.md for ${ref}: ${err instanceof Error ? err.message : String(err)}` };
    }

    const frontmatter = parseSkillFrontmatter(content);
    const name = frontmatter['name'];
    if (!name || !frontmatter['description']) {
      return { ok: false, error: `SKILL.md for ${ref} must declare name and description frontmatter` };
    }

    const targetDir = join(workspaceRoot, '.agents', 'skills', sanitizeSkillDirName(name));
    try {
      // The CLI replaces an existing install rather than merging into it, and
      // copies with dereference (no links out of the workspace into the source).
      await rm(targetDir, { recursive: true, force: true });
      await cp(sourceDir, targetDir, {
        recursive: true,
        dereference: true,
        filter: (src) => !EXCLUDED_ENTRIES.has(basename(src)),
      });
    } catch (err) {
      return { ok: false, error: `local install of ${ref} failed: ${err instanceof Error ? err.message : String(err)}` };
    }

    return { ok: true, output: `Installed ${name} from local source` };
  }
}
