// Phase 4 T5 — install every assigned external skill into the agent workspace at
// agent start (ADR 017 §1, D23). For each resolved skill carrying a `sourceRef`
// we run the external installer (`npx skills add <ref> --yes` in production),
// then refresh the stored `name`/`description` from the installed SKILL.md
// frontmatter and stamp `last_installed_at`. A failure marks the skill
// UNAVAILABLE for this session (progressive disclosure reports it, T7) and logs a
// warning — it NEVER throws into agent start (EC-7, EC-11).

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExternalSkillInstaller } from '@herobids/domain';
import type { Database } from '@herobids/db';
import { upsertExternalSkill } from '@herobids/db';
import { createLogger } from './logger.js';
import {
  activateExternalSkill,
  deriveSkillDirName,
  normalizeExternalRef,
} from './tools/skills.js';

const logger = createLogger('external-skill-startup');

/** Per-session availability of one external skill after the start-time install. */
export interface SessionExternalSkillState {
  /** Canonical `owner/repo/skill` ref. */
  sourceRef: string;
  available: boolean;
  /** Refreshed display name (from frontmatter on success). */
  name: string;
  description: string;
  /** Short reason when unavailable (install failed / source unreachable). */
  unavailableReason?: string;
}

/** The resolved-skill shape this loop needs (a subset of SkillDefinition). */
export interface InstallableExternalSkill {
  id: string;
  name: string;
  description: string;
  sourceRef: string;
}

/**
 * Install each external skill into `workspaceRoot/.agents/skills/<name>/` and
 * refresh its metadata. Returns a map keyed by the canonical ref. Never throws.
 */
export async function installExternalSkillsAtStart(input: {
  externalSkills: InstallableExternalSkill[];
  workspaceRoot: string;
  installer: ExternalSkillInstaller;
  db?: Database | undefined;
}): Promise<Map<string, SessionExternalSkillState>> {
  const { externalSkills, workspaceRoot, installer, db } = input;
  const result = new Map<string, SessionExternalSkillState>();

  // Sequential — the skills CLI is not safe to run in parallel in one workspace.
  for (const skill of externalSkills) {
    const sourceRef = skill.sourceRef;
    let state: SessionExternalSkillState = {
      sourceRef,
      available: false,
      name: skill.name,
      description: skill.description,
    };

    const activation = await activateExternalSkill({
      ref: sourceRef,
      workspaceRoot,
      installer,
      fallback: { name: skill.name, description: skill.description },
    });
    if (activation.status === 'ready') {
      // Refresh name/description from the installed SKILL.md frontmatter.
      state = { sourceRef, available: true, name: activation.name, description: activation.description };
    } else {
      state = { ...state, available: false, unavailableReason: activation.reason };
      logger.warn({ sourceRef, error: activation.reason }, 'External skill install failed — skill unavailable this session');
    }

    result.set(sourceRef, state);

    // Best-effort DB refresh (never blocks agent start on a DB hiccup).
    if (db) {
      try {
        await upsertExternalSkill(db, {
          sourceRef,
          name: state.name,
          description: state.description,
          lastInstalledAt: state.available ? new Date() : null,
        });
      } catch (err) {
        logger.warn({ sourceRef, err }, 'Failed to refresh external skill metadata row after install');
      }
    }
  }

  return result;
}



/**
 * Read an installed skill's SKILL.md body (frontmatter stripped) from the
 * workspace. Returns `null` when the file is absent (install failed / not yet
 * installed) — the caller reports "temporarily unavailable". No network.
 */
export async function readInstalledSkillBody(
  workspaceRoot: string,
  sourceRef: string,
): Promise<string | null> {
  const dirName = deriveSkillDirName(normalizeExternalRef(sourceRef).ref);
  const skillMdPath = join(workspaceRoot, '.agents', 'skills', dirName, 'SKILL.md');
  try {
    const content = await readFile(skillMdPath, 'utf-8');
    return stripFrontmatter(content);
  } catch {
    return null;
  }
}

/** Remove a leading `--- ... ---` YAML frontmatter block, returning the body. */
export function stripFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return match ? content.slice(match[0].length).trimStart() : content;
}
